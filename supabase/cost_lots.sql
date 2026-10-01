-- =====================================================================
-- 便ごとの原価（先入先出）用テーブル・関数
-- Supabase SQL Editor でこのファイルを丸ごと実行してください（再実行可）。
-- =====================================================================

-- 便（配送依頼書）
create table if not exists public.cost_shipments (
  shipment_id      text primary key,               -- 配送依頼書番号 P2026...-2147
  source_file      text,
  processed_at     timestamptz not null default now(),
  rate             numeric not null,                -- 配送依頼書レート
  goods_cny        numeric,
  option_cny       numeric,
  domestic_cny     numeric,
  intl_freight_jpy numeric,
  other_fee_jpy    numeric,
  chargeable_kg    numeric,
  intl_method      text,                            -- box / value
  total_jpy        numeric,
  allocated_jpy    numeric,
  ignored_jpy      numeric,
  unallocated_jpy  numeric,
  detail           jsonb,                           -- 明細・コード別内訳（監査用）
  created_by       uuid default auth.uid()
);

-- 便ごとの在庫（原価レイヤー）
create table if not exists public.cost_lots (
  id             bigserial primary key,
  product_code   text not null,
  lot_type       text not null default 'shipment'
                 check (lot_type in ('shipment', 'opening', 'adjust')),
  shipment_id    text references public.cost_shipments(shipment_id) on delete cascade,
  received_at    timestamptz not null default now(),
  qty_in         integer not null check (qty_in >= 0),
  qty_remaining  integer not null check (qty_remaining >= 0),
  unit_cost      numeric(14, 4),                    -- 1単位あたり原価（円）
  unit_goods     numeric(14, 4),
  unit_option    numeric(14, 4),
  unit_domestic  numeric(14, 4),
  unit_intl      numeric(14, 4),
  unit_other     numeric(14, 4),
  needs_review   boolean not null default false,
  note           text,
  created_at     timestamptz not null default now()
);

-- 期首在庫を、最初に原価計算された便の原価で置き換えたときの便
alter table public.cost_lots add column if not exists revalued_shipment_id text;

create unique index if not exists cost_lots_shipment_uniq
  on public.cost_lots (lower(product_code), shipment_id)
  where lot_type = 'shipment';
create index if not exists cost_lots_code_fifo_idx
  on public.cost_lots (lower(product_code), received_at, id);

-- 入数マスタ（1行に複数コードがある行の按分用）
create table if not exists public.cost_unit_rules (
  product_code_lc  text primary key,
  product_code     text not null,
  pieces_per_unit  numeric not null check (pieces_per_unit > 0),
  note             text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid()
);

-- 共有資材ルール（商品コードのない行。注文番号+商品番号で識別）
create table if not exists public.cost_material_rules (
  order_no     text not null,
  item_no      text not null,
  allocations  jsonb not null default '[]'::jsonb,  -- [{"productCode":"x","qtyPerUnit":1}]
  ignore       boolean not null default false,      -- true = 原価に含めない
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  primary key (order_no, item_no)
);

-- 在庫照合ログ
create table if not exists public.cost_stock_log (
  id               bigserial primary key,
  product_code     text not null,
  logged_at        timestamptz not null default now(),
  event            text not null,                  -- receipt / sync
  shipment_id      text,
  ne_stock         integer,
  lots_qty_before  integer,
  consumed         integer not null default 0,
  adjusted         integer not null default 0,
  opening          integer not null default 0,
  added            integer not null default 0,
  detail           jsonb
);
create index if not exists cost_stock_log_code_idx
  on public.cost_stock_log (lower(product_code), logged_at desc);

-- ---------------------------------------------------------------------
-- RLS：ログイン済みユーザー（入庫一括と同じSupabase Auth）のみ
-- ---------------------------------------------------------------------
alter table public.cost_shipments      enable row level security;
alter table public.cost_lots           enable row level security;
alter table public.cost_unit_rules     enable row level security;
alter table public.cost_material_rules enable row level security;
alter table public.cost_stock_log      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cost_shipments','cost_lots','cost_unit_rules','cost_material_rules','cost_stock_log'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t
    );
  end loop;
end $$;

grant select, insert, update, delete on
  public.cost_shipments, public.cost_lots, public.cost_unit_rules,
  public.cost_material_rules, public.cost_stock_log
  to authenticated, service_role;
grant usage, select on sequence public.cost_lots_id_seq, public.cost_stock_log_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1商品の在庫照合（先入先出）
--   NE在庫 < 便の残数合計 → 差分を古い便から消費（期首在庫がいちばん古い扱い）
--   NE在庫 > 便の残数合計 → 通常：差分を「調整」として追加（最新の原価）
--                            過去の便の登録（p_backfill）：差分は便より前からあった在庫なので「期首在庫」として追加
--   便が1つもない → NE在庫を「期首」便として作成（NEの現在原価。最初の便の原価計算で置き換わる）
-- ---------------------------------------------------------------------
drop function if exists public.cost__reconcile(text, integer, numeric, text, text);
create or replace function public.cost__reconcile(
  p_code        text,
  p_stock       integer,
  p_cost_price  numeric,
  p_event       text,
  p_shipment_id text default null,
  p_backfill    boolean default false
) returns jsonb
language plpgsql
as $$
declare
  v_lots_qty   integer;
  v_lot_count  integer;
  v_stock      integer;
  v_diff       integer;
  v_take       integer;
  v_consumed   integer := 0;
  v_adjusted   integer := 0;
  v_opening    integer := 0;
  v_latest     numeric;
  r            record;
begin
  -- 同じ商品の照合が同時に走らないようにする（期首・調整の二重作成防止）
  perform pg_advisory_xact_lock(hashtext(lower(p_code)));

  select coalesce(sum(qty_remaining), 0), count(*)
    into v_lots_qty, v_lot_count
    from public.cost_lots
   where lower(product_code) = lower(p_code);

  if p_stock is null then
    insert into public.cost_stock_log(product_code, event, shipment_id, ne_stock, lots_qty_before, detail)
    values (p_code, p_event, p_shipment_id, null, v_lots_qty,
            jsonb_build_object('warning', 'NE在庫が取得できなかったため照合していません'));
    return jsonb_build_object('product_code', p_code, 'skipped', true);
  end if;

  v_stock := greatest(p_stock, 0);

  if v_lot_count = 0 then
    if v_stock > 0 then
      insert into public.cost_lots(product_code, lot_type, qty_in, qty_remaining, unit_cost, needs_review, note)
      values (p_code, 'opening', v_stock, v_stock, p_cost_price,
              (p_cost_price is null or p_cost_price <= 0),
              '期首在庫（NEの在庫数・原価から作成）');
      v_opening := v_stock;
    end if;
  elsif v_lots_qty > v_stock then
    v_diff := v_lots_qty - v_stock;
    for r in
      select id, qty_remaining
        from public.cost_lots
       where lower(product_code) = lower(p_code) and qty_remaining > 0
       order by (lot_type <> 'opening'), received_at, id
       for update
    loop
      exit when v_diff <= 0;
      v_take := least(v_diff, r.qty_remaining);
      update public.cost_lots set qty_remaining = qty_remaining - v_take where id = r.id;
      v_diff := v_diff - v_take;
      v_consumed := v_consumed + v_take;
    end loop;
  elsif v_lots_qty < v_stock and p_backfill then
    insert into public.cost_lots(product_code, lot_type, received_at, qty_in, qty_remaining, unit_cost, needs_review, note)
    select p_code, 'opening',
           least(now(), coalesce(min(received_at), now()) - interval '1 second'),
           v_stock - v_lots_qty, v_stock - v_lots_qty, p_cost_price,
           (p_cost_price is null or p_cost_price <= 0),
           '期首在庫（登録した過去の便より前からあった分）'
      from public.cost_lots where lower(product_code) = lower(p_code);
    v_opening := v_stock - v_lots_qty;
  elsif v_lots_qty < v_stock then
    select unit_cost into v_latest
      from public.cost_lots
     where lower(product_code) = lower(p_code) and unit_cost is not null
     order by received_at desc, id desc
     limit 1;
    insert into public.cost_lots(product_code, lot_type, qty_in, qty_remaining, unit_cost, needs_review, note)
    values (p_code, 'adjust', v_stock - v_lots_qty, v_stock - v_lots_qty,
            coalesce(v_latest, p_cost_price), (coalesce(v_latest, p_cost_price) is null),
            'NE在庫が便の残数より多い分（返品・棚卸増など）');
    v_adjusted := v_stock - v_lots_qty;
  end if;

  insert into public.cost_stock_log(product_code, event, shipment_id, ne_stock, lots_qty_before, consumed, adjusted, opening)
  values (p_code, p_event, p_shipment_id, v_stock, v_lots_qty, v_consumed, v_adjusted, v_opening);

  return jsonb_build_object(
    'product_code', p_code, 'ne_stock', v_stock, 'lots_qty_before', v_lots_qty,
    'consumed', v_consumed, 'adjusted', v_adjusted, 'opening', v_opening
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 入庫一括から呼ぶ：便の登録 + 在庫照合 + 新しい便の追加（1トランザクション）
-- p = {
--   "mode":      "receipt"（通常の入庫）| "backfill"（過去の便を原価だけ登録）,
--   "shipments": [{shipment_id, source_file, rate, goods_cny, ..., detail}],
--   "lots":      [{product_code, shipment_id, qty, unit_cost, unit_goods, unit_option,
--                  unit_domestic, unit_intl, unit_other, needs_review, note, received_at}],
--   "stock":     [{product_code, stock_quantity, cost_price}]
--                 receipt：NEアップロード直前の在庫（入庫分を含まない）
--                 backfill：今のNE在庫（過去の便の分はすでに含まれている）
-- }
-- receipt ：照合 → 便を追加（登録日は今）
-- backfill：便を追加（登録日は配送依頼書の日付）→ 照合（足りない分は期首在庫としていちばん古い位置へ）
-- どちらも最後に、まだ置き換えていない期首在庫の原価を、今回登録したいちばん古い便の原価で置き換える。
-- 同じ便・同じ商品がすでに登録済みならスキップ（再実行しても二重登録しない）
-- ---------------------------------------------------------------------
drop function if exists public.cost_register_receipt(jsonb);
create or replace function public.cost_register_receipt(p jsonb)
returns jsonb
language plpgsql
as $$
declare
  s            jsonb;
  l            jsonb;
  v_code       text;
  v_stock      jsonb;
  v_mode       text := coalesce(p->>'mode', 'receipt');
  v_backfill   boolean := coalesce(p->>'mode', 'receipt') = 'backfill';
  v_results    jsonb := '[]'::jsonb;
  v_registered integer := 0;
  v_skipped    integer := 0;
  v_revalued   integer := 0;
  v_rec        jsonb;
  v_id         bigint;
  v_ids        bigint[];
  v_first      record;
  v_count      integer;
begin
  if v_mode not in ('receipt', 'backfill') then
    raise exception 'mode は receipt か backfill を指定してください: %', v_mode;
  end if;

  for s in select * from jsonb_array_elements(coalesce(p->'shipments', '[]'::jsonb)) loop
    insert into public.cost_shipments(
      shipment_id, source_file, rate, goods_cny, option_cny, domestic_cny,
      intl_freight_jpy, other_fee_jpy, chargeable_kg, intl_method,
      total_jpy, allocated_jpy, ignored_jpy, unallocated_jpy, detail)
    values (
      s->>'shipment_id', s->>'source_file', (s->>'rate')::numeric,
      (s->>'goods_cny')::numeric, (s->>'option_cny')::numeric, (s->>'domestic_cny')::numeric,
      (s->>'intl_freight_jpy')::numeric, (s->>'other_fee_jpy')::numeric,
      (s->>'chargeable_kg')::numeric, s->>'intl_method',
      (s->>'total_jpy')::numeric, (s->>'allocated_jpy')::numeric,
      (s->>'ignored_jpy')::numeric, (s->>'unallocated_jpy')::numeric, s->'detail')
    on conflict (shipment_id) do nothing;
  end loop;

  for v_code in
    select distinct on (lower(x->>'product_code')) x->>'product_code'
      from jsonb_array_elements(coalesce(p->'lots', '[]'::jsonb)) x
     order by lower(x->>'product_code')
  loop
    -- この商品の便のうち未登録のものがなければスキップ
    if not exists (
      select 1
        from jsonb_array_elements(p->'lots') x
       where lower(x->>'product_code') = lower(v_code)
         and not exists (
           select 1 from public.cost_lots c
            where c.lot_type = 'shipment'
              and lower(c.product_code) = lower(v_code)
              and c.shipment_id = x->>'shipment_id')
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select x into v_stock
      from jsonb_array_elements(coalesce(p->'stock', '[]'::jsonb)) x
     where lower(x->>'product_code') = lower(v_code)
     limit 1;

    if not v_backfill then
      v_rec := public.cost__reconcile(
        v_code,
        nullif(v_stock->>'stock_quantity', '')::numeric::integer,
        nullif(v_stock->>'cost_price', '')::numeric,
        'receipt', null, false);
    end if;

    v_ids := array[]::bigint[];
    for l in
      select x from jsonb_array_elements(p->'lots') x
       where lower(x->>'product_code') = lower(v_code)
       order by x->>'shipment_id'
    loop
      if (l->>'qty')::integer <= 0 then continue; end if;
      v_id := null;
      insert into public.cost_lots(
        product_code, lot_type, shipment_id, received_at, qty_in, qty_remaining,
        unit_cost, unit_goods, unit_option, unit_domestic, unit_intl, unit_other,
        needs_review, note)
      values (
        l->>'product_code', 'shipment', l->>'shipment_id',
        case when v_backfill then coalesce(nullif(l->>'received_at', '')::timestamptz, now()) else now() end,
        (l->>'qty')::integer, (l->>'qty')::integer,
        (l->>'unit_cost')::numeric, (l->>'unit_goods')::numeric, (l->>'unit_option')::numeric,
        (l->>'unit_domestic')::numeric, (l->>'unit_intl')::numeric, (l->>'unit_other')::numeric,
        coalesce((l->>'needs_review')::boolean, false),
        case when v_backfill then concat_ws(' / ', '過去の便を原価だけ登録', l->>'note') else l->>'note' end)
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then
        v_ids := v_ids || v_id;
        v_registered := v_registered + 1;
      end if;
    end loop;

    if v_backfill then
      v_rec := public.cost__reconcile(
        v_code,
        nullif(v_stock->>'stock_quantity', '')::numeric::integer,
        nullif(v_stock->>'cost_price', '')::numeric,
        'backfill', null, true);
    end if;

    -- 照合ログに追加数と便を記録
    update public.cost_stock_log
       set added = added + coalesce((select sum(qty_in) from public.cost_lots where id = any(v_ids)), 0),
           shipment_id = coalesce(shipment_id, (select min(shipment_id) from public.cost_lots where id = any(v_ids)))
     where id = (select max(id) from public.cost_stock_log where lower(product_code) = lower(v_code));

    -- 期首在庫の原価を、今回登録したいちばん古い便（要確認でないもの）の原価で置き換える（1回だけ）
    select * into v_first
      from public.cost_lots
     where id = any(v_ids) and not needs_review and unit_cost is not null
     order by received_at, shipment_id
     limit 1;
    if found then
      update public.cost_lots
         set unit_cost = v_first.unit_cost,
             unit_goods = v_first.unit_goods,
             unit_option = v_first.unit_option,
             unit_domestic = v_first.unit_domestic,
             unit_intl = v_first.unit_intl,
             unit_other = v_first.unit_other,
             needs_review = false,
             revalued_shipment_id = v_first.shipment_id,
             note = '期首在庫（原価は ' || v_first.shipment_id || ' の便から）'
       where lower(product_code) = lower(v_code)
         and lot_type = 'opening'
         and revalued_shipment_id is null;
      get diagnostics v_count = row_count;
      v_revalued := v_revalued + v_count;
    end if;

    v_results := v_results || jsonb_build_array(v_rec);
  end loop;

  return jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'registered_lots', v_registered,
    'skipped_products', v_skipped,
    'revalued_opening_lots', v_revalued,
    'reconciled', v_results
  );
end;
$$;

-- 商品ごとに登録済みのいちばん新しい便（NEの原価を古い便の値で上書きしないための確認用）
create or replace function public.cost_latest_shipments(p_codes text[])
returns table(product_code_lc text, shipment_id text)
language sql
stable
as $$
  select lower(product_code), max(shipment_id)
    from public.cost_lots
   where lot_type = 'shipment'
     and lower(product_code) = any(select lower(c) from unnest(p_codes) c)
   group by lower(product_code);
$$;

-- ---------------------------------------------------------------------
-- 在庫金額アプリ用：NE在庫で照合だけ行う（入庫なし）
-- p = { "stock": [{product_code, stock_quantity, cost_price}], "seed_opening": true|false }
-- seed_opening=false のときは便が1つもない商品は何もしない
-- ---------------------------------------------------------------------
create or replace function public.cost_reconcile_stock(p jsonb)
returns jsonb
language plpgsql
as $$
declare
  x         jsonb;
  v_seed    boolean := coalesce((p->>'seed_opening')::boolean, false);
  v_results jsonb := '[]'::jsonb;
begin
  for x in select * from jsonb_array_elements(coalesce(p->'stock', '[]'::jsonb)) loop
    if not v_seed and not exists (
      select 1 from public.cost_lots where lower(product_code) = lower(x->>'product_code')
    ) then
      continue;
    end if;
    v_results := v_results || jsonb_build_array(public.cost__reconcile(
      x->>'product_code',
      nullif(x->>'stock_quantity', '')::numeric::integer,
      nullif(x->>'cost_price', '')::numeric,
      'sync',
      null,
      false));
  end loop;
  return jsonb_build_object('ok', true, 'reconciled', v_results);
end;
$$;

grant execute on function public.cost__reconcile(text, integer, numeric, text, text, boolean) to authenticated, service_role;
grant execute on function public.cost_latest_shipments(text[]) to authenticated, service_role;
grant execute on function public.cost_register_receipt(jsonb) to authenticated, service_role;
grant execute on function public.cost_reconcile_stock(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 商品ごとの在庫金額（便の残数 × 便の原価）
-- ---------------------------------------------------------------------
create or replace view public.cost_inventory_by_product
with (security_invoker = true) as
select
  max(product_code)                                          as product_code,
  lower(product_code)                                        as product_code_lc,
  sum(qty_remaining)::integer                                as qty,
  round(sum(qty_remaining * coalesce(unit_cost, 0)), 0)      as value_jpy,
  case when sum(qty_remaining) > 0
       then round(sum(qty_remaining * coalesce(unit_cost, 0)) / sum(qty_remaining), 2)
  end                                                        as avg_unit_cost,
  (array_agg(unit_cost order by received_at desc, id desc)
     filter (where lot_type = 'shipment'))[1]               as latest_unit_cost,
  count(*) filter (where qty_remaining > 0)::integer         as open_lots,
  bool_or(needs_review and qty_remaining > 0)                as needs_review
from public.cost_lots
group by lower(product_code);

grant select on public.cost_inventory_by_product to authenticated, service_role;

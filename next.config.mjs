import type { NextConfig } from "next";

const repo = "nyuko-ikkatsu";
const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isProd ? `/${repo}` : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
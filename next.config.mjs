/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: process.env.NODE_ENV === "production" ? "/nyuko-ikkatsu" : "",
  assetPrefix: process.env.NODE_ENV === "production" ? "/nyuko-ikkatsu/" : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

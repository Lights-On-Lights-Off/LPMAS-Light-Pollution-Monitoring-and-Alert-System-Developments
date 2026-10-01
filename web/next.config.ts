import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{source:'/:path*', headers:[
      {key:'X-Content-Type-Options', value:'nosniff'},
      {key:'X-Frame-Options', value:'DENY'},
      {key:'Referrer-Policy', value:'strict-origin-when-cross-origin'},
      {key:'Permissions-Policy', value:'camera=(), microphone=(), geolocation=()'},
      {key:'Content-Security-Policy', value:"frame-ancestors 'none'; base-uri 'self'; object-src 'none'"},
      {key:'Strict-Transport-Security', value:'max-age=31536000; includeSubDomains'},
    ]}];
  },
};
export default nextConfig;

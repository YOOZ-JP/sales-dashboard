import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts', 'framer-motion', '@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-tabs', '@radix-ui/react-tooltip', '@radix-ui/react-toggle-group', '@radix-ui/react-dropdown-menu'],
  },
  outputFileTracingIncludes: {
    '/api/settlement/upload': ['./src/features/settlement/data/aliases/**/*'],
    '/api/settlement/export-v2/[month]': ['./src/features/settlement/data/templates/input_jp_2026_v2_template.xlsx'],
  },
  serverExternalPackages: ['exceljs'],
};

export default nextConfig;

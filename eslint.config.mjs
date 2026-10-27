import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';
const config = [
  { ignores: ['.next/**', '.open-next/**', '.wrangler/**', 'node_modules/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
  { files: ['crawler/engine/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['**/src','**/src/**','**/shared','**/shared/**','**/config','**/config/**','**/profiles','**/profiles/**','@/shared/**','@/crawler/**'], message: 'Engine infrastructure must not import service policy or data access.' }
  ] }] } },
];
export default config;

import { mkdir, writeFile } from 'node:fs/promises';
import { buildSeedSql } from './seed-sql';

const seed = buildSeedSql();
await mkdir('.local', { recursive: true });
await writeFile('.local/seed.sql', seed.sql);
console.info(`시드 SQL 생성: 모델 ${seed.modelCount}개, 판매자 ${seed.sellerCount}개. 가격 출처일 ${seed.checked}`);

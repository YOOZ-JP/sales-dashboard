import { config } from 'dotenv';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

config({ path: path.resolve(import.meta.dirname, '..', '.env.local') });
const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

// 모든 에디션 접미사를 제거해서 원본 제목만 남기기
function stripEdition(title: string): string {
  return title
    .replace(/【分冊版】|【特装版】|【連載版】|【完全版】/g, '')
    .replace(/\[完全版\]|\[판면\/화별\]|\[판면\]/g, '')
    .replace(/（ノベル）|\(ノベル\)/g, '')
    .replace(/\[\d+권\]/g, '')
    .replace(/\s*（\d+）/g, '')
    .replace(/\s*\(\d+\)/g, '')
    .replace(/\s*\d+$/, '')
    .replace(/\u3000/g, ' ')
    .trim();
}

async function main() {
  const { data: allTitles } = await sb.from('titles').select('id, title_jp, genre_id, production_company_id');

  // 1단계: 장르 있는 작품의 "핵심 제목" → genre_id 매핑
  const coreGenre = new Map<string, number>();
  const coreCompany = new Map<string, number>();

  for (const t of allTitles ?? []) {
    const core = stripEdition(t.title_jp);
    if (t.genre_id && !coreGenre.has(core)) coreGenre.set(core, t.genre_id);
    if (t.production_company_id && !coreCompany.has(core)) coreCompany.set(core, t.production_company_id);
  }

  // 2단계: 장르 없는 작품 매칭
  const noGenre = (allTitles ?? []).filter(t => !t.genre_id);
  let fixed = 0;

  for (const t of noGenre) {
    const core = stripEdition(t.title_jp);
    let gid = coreGenre.get(core);
    let cid = !t.production_company_id ? coreCompany.get(core) : undefined;

    // 3단계: 부분 매칭 (core의 앞부분으로)
    if (!gid && core.length >= 3) {
      for (const [k, v] of coreGenre) {
        // 앞 3~6글자가 같으면 매칭
        const matchLen = Math.min(core.length, k.length, 6);
        if (core.slice(0, matchLen) === k.slice(0, matchLen) && Math.abs(core.length - k.length) <= 15) {
          gid = v;
          if (!cid) cid = coreCompany.get(k);
          break;
        }
      }
    }

    if (gid || cid) {
      const updates: Record<string, number> = {};
      if (gid) updates.genre_id = gid;
      if (cid) updates.production_company_id = cid;
      const { error } = await sb.from('titles').update(updates).eq('id', t.id);
      if (!error) {
        fixed++;
        if (fixed <= 20) console.log(`  ✓ ${t.title_jp.slice(0, 35)} → ${core.slice(0, 20)}`);
      }
    }
  }

  console.log(`\n수정: ${fixed}/${noGenre.length}`);
  const { count: withGenre } = await sb.from('titles').select('*', { count: 'exact', head: true }).not('genre_id', 'is', null);
  const { count: total } = await sb.from('titles').select('*', { count: 'exact', head: true });
  console.log(`최종: 장르 ${withGenre}/${total}`);
}

main().catch(console.error);

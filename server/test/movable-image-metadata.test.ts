import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('real process image metadata before same-volume movement', () => {
  it('keeps default Sharp caching and pixel limits while Chinese WebP/JPEG inputs can link/unlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'movable-metadata-real-process-'));
    const helper = new URL('../src/utils/movable-image-metadata.ts', import.meta.url).href;
    const sharpModule = new URL('../node_modules/sharp/lib/index.js', import.meta.url).href;
    const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const script = `
      import fs from 'node:fs/promises'; import path from 'node:path';
      import sharp from ${JSON.stringify(sharpModule)};
      import {readMovableImageMetadata} from ${JSON.stringify(helper)};
      const root=process.argv[1],before=sharp.cache(),start=performance.now(),rss=process.memoryUsage().rss;
      const jpeg=await sharp({create:{width:48,height:64,channels:3,background:'#587492'}}).jpeg().toBuffer();
      const webp=await sharp(jpeg).webp().toBuffer(); const times=[];
      for(let index=0;index<6;index++){
        const extension=index%2?'.jpg':'.webp';
        const source=path.join(root,'中文 带空格 ['+index+']'+extension),target=path.join(root,'moved-'+index+extension);
        const bytes=index%2?Buffer.concat([jpeg,Buffer.alloc(4*1024*1024)]):webp;
        await fs.writeFile(source,bytes);
        const t=performance.now(); const meta=await readMovableImageMetadata(source); times.push(performance.now()-t);
        if(meta.width!==48||meta.height!==64)throw Error('Metadata changed');
        await fs.link(source,target); await fs.unlink(source);
        const stat=await fs.stat(target,{bigint:true}); if(stat.nlink!==1n)throw Error('Move not complete');
      }
      const oversized=Buffer.from(jpeg);
      for(let p=2;p<oversized.length-9;){const marker=oversized[p+1],size=oversized.readUInt16BE(p+2);
        if([0xc0,0xc1,0xc2].includes(marker)){oversized.writeUInt16BE(32768,p+5);oversized.writeUInt16BE(32768,p+7);break;}p+=2+size;}
      const pixel=path.join(root,'超限.jpeg');await fs.writeFile(pixel,oversized);
      let limited=false;try{await readMovableImageMetadata(pixel);}catch(error){limited=/pixel limit/i.test(error.message);}
      if(!limited)throw Error('Default pixel safety limit was not kept');
      const after=sharp.cache();if(before.files.max!==after.files.max||before.items.max!==after.items.max||before.memory.max!==after.memory.max)throw Error('Global Sharp cache changed');
      console.log(JSON.stringify({files:6,pixelLimit:limited,cache:after,defaultFileCache:before.files.max,timesMs:times,durationMs:performance.now()-start,rssDelta:process.memoryUsage().rss-rss,maxRSSKiB:process.resourceUsage().maxRSS}));
    `;
    try {
      const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script, root], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const report = JSON.parse(result.stdout.trim());
      expect(report).toMatchObject({ files: 6, pixelLimit: true, defaultFileCache: 20 });
      expect(report.timesMs).toHaveLength(6);
      console.info('Movable metadata default-cache process evidence', report);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 35_000);
});

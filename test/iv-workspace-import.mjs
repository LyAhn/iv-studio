import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IVWorkspace } from '../src/service/iv-workspace.js'
import { receiveStudio } from '../src/service/iv-workspace-import.js'
import { Productions } from '../src/service/productions.js'
test('Studio receives a native prepared project once without starting generation',t=>{
 const root=mkdtempSync(join(tmpdir(),'studio-handoff-')),w=new IVWorkspace({root:join(root,'shared'),appId:'outreach'}),productions=new Productions({dataDir:root,studio:()=>{throw Error('No render engine should be used')}})
 t.after(()=>{w.close();rmSync(root,{recursive:true,force:true})})
 const brand=w.saveBrand({name:'Fixture',voice:'Practical',offer:'Helpful services'}),h=w.createHandoff({target:'studio',brandId:brand.id,sourceKey:'fixture',brief:{title:'Helpful content',goal:'Explain a service',channel:'Instagram',evidence:[{url:'https://example.com',title:'Source',excerpt:'An observed fact'}]}})
 const result=receiveStudio(h,w,productions),p=productions.get(result.id)
 assert.equal(p.step,'idea');assert.equal(p.aspect,'9:16');assert.match(p.look.notes,/Practical/);assert.match(p.look.notes,/An observed fact/);assert.equal(p.scenes.length,0)
 productions.update(p.id,{name:'My edited title'});assert.equal(receiveStudio(h,w,productions).id,p.id);assert.equal(productions.get(p.id).name,'My edited title');assert.equal(productions.list().length,1)
})

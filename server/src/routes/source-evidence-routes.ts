import { Router } from 'express';
import { z } from 'zod';
import { SourceEvidenceError, SourceEvidenceService, sourceEvidenceRecordSchema } from '../services/source-evidence-service.js';

export function createSourceEvidenceRouter(service?:SourceEvidenceService) {
  const router = Router();
  const current=()=>service??new SourceEvidenceService();
  const id=z.coerce.number().int().positive();
  const key=z.string().trim().min(1).max(240);
  const reason=z.string().trim().min(1).max(2000);
  router.get('/',(req,res)=>{
    const query=z.object({creatorId:id,page:id.optional(),limit:id.max(100).optional()}).parse(req.query);
    res.json(current().list(query));
  });
  router.post('/',(req,res)=>{
    const body=z.object({creatorId:id,requestId:key,record:sourceEvidenceRecordSchema}).strict().parse(req.body);
    if(body.record.method!=='manual')throw new SourceEvidenceError('管理入口仅接收手工登记；插件需使用带领取保护的桥接入口。');
    res.status(201).json({ok:true,recorded:true,observation:current().save(body)});
  });
  router.get('/:id',(req,res)=>{res.json(current().get(id.parse(req.params.id)));});
  router.post('/:id/confirm-identity',(req,res)=>{
    const body=z.object({creatorId:id,requestId:key,reason,expectedRevision:z.number().int().nonnegative()}).strict().parse(req.body);
    res.json({ok:true,observation:current().confirmIdentity(id.parse(req.params.id),body)});
  });
  router.post('/:id/links',(req,res)=>{
    const body=z.object({creatorId:id,workId:id,localWorkId:id.optional(),key,reason,entryKey:key.optional()}).strict().parse(req.body);
    res.json({ok:true,link:current().linkAdmission({...body,observationId:id.parse(req.params.id)})});
  });
  router.post('/:id/entry-mappings',(req,res)=>{
    const body=z.object({creatorId:id,workId:id,sourceWorkId:id.optional(),entryKey:key,key,reason}).strict().parse(req.body);
    res.json({ok:true,mapping:current().mapEntry({...body,observationId:id.parse(req.params.id)})});
  });
  router.use((error:unknown,_req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>{
    if(error instanceof SourceEvidenceError)res.status(error.status).json({ok:false,message:error.message});
    else next(error);
  });
  return router;
}

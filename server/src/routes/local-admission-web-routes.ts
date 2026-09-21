import { Router } from 'express';
import { z } from 'zod';
import { AdmissionWebError, LocalAdmissionWebService } from '../services/local-admission-web-service.js';
import { databaseManager } from '../db/database.js';

export function createLocalAdmissionWebRouter(service?:LocalAdmissionWebService) {
  const router=Router();let instance=service,connection:import('node:sqlite').DatabaseSync|undefined;
  const current=()=>{if(service)return service;const db=databaseManager.connection;if(db!==connection){connection=db;instance=new LocalAdmissionWebService(db);}return instance!;};
  const id=z.string().uuid(),number=z.coerce.number().int().positive();
  router.get('/settings',(_req,res)=>res.json(current().settings()));
  router.get('/workspace',async(_req,res)=>res.json(await current().workspace()));
  router.get('/creators',(req,res)=>res.json(current().creators(z.string().max(500).default('').parse(req.query.q),number.default(1).parse(req.query.page),number.max(50).default(20).parse(req.query.pageSize))));
  router.post('/collections/previews',async(req,res)=>res.status(201).json(await current().previewCollection(req.body)));
  router.get('/collections',(req,res)=>res.json(current().collections(number.default(1).parse(req.query.page))));
  router.get('/collections/:id',(req,res)=>res.json(current().collection(id.parse(req.params.id))));
  router.post('/collections/:id/execute',async(req,res)=>res.status(202).json(await current().executeCollection(id.parse(req.params.id),req.body)));
  router.post('/collections/:id/resume',(req,res)=>res.status(202).json(current().resumeCollection(id.parse(req.params.id),req.body)));
  router.put('/settings',async(req,res)=>res.json(await current().saveSettings(z.object({waitingRoot:z.string().min(1).max(4000)}).strict().parse(req.body).waitingRoot)));
  router.get('/directories',async(req,res)=>res.json(await current().directories(number.parse(req.query.creatorId),z.string().optional().parse(req.query.parent))));
  router.get('/works',(req,res)=>res.json(current().works(number.parse(req.query.creatorId),z.string().max(500).default('').parse(req.query.q),number.default(1).parse(req.query.page),number.max(50).default(24).parse(req.query.pageSize))));
  router.post('/previews',async(req,res)=>res.status(201).json(await current().preview(req.body)));
  router.get('/batches',(req,res)=>res.json(current().list(number.optional().parse(req.query.creatorId),number.default(1).parse(req.query.page))));
  router.get('/batches/:id',(req,res)=>res.json(current().get(id.parse(req.params.id))));
  router.get('/batches/:id/items',(req,res)=>res.json(current().items(id.parse(req.params.id),number.default(1).parse(req.query.page),number.max(100).default(24).parse(req.query.pageSize))));
  router.post('/batches/:id/execute',async(req,res)=>res.status(202).json(await current().execute(id.parse(req.params.id),req.body)));
  router.post('/batches/:id/resume',(req,res)=>res.status(202).json(current().resume(id.parse(req.params.id),req.body)));
  router.post('/batches/:id/repreview',async(req,res)=>res.status(201).json(await current().repreview(id.parse(req.params.id),z.object({keys:z.array(z.string().min(1)).max(500).optional()}).strict().parse(req.body).keys)));
  router.use((error:unknown,_req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>{
    if(error instanceof AdmissionWebError)res.status(error.status).json({message:error.message});else next(error);
  });
  return router;
}

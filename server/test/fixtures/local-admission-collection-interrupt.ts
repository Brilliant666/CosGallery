import fs from 'node:fs/promises';
console.log=console.error;console.info=console.error;
const [id,inputPath]=process.argv.slice(2);
if(process.env.NODE_ENV!=='test'||!id||!inputPath)throw Error('Synthetic interruption fixture requires an explicit test collection');
const {LocalAdmissionWebService}=await import('../../src/services/local-admission-web-service.js');
const result=await new LocalAdmissionWebService().executeCollection(id,JSON.parse(await fs.readFile(inputPath,'utf8')));
// Simulate a process exit after the durable acknowledgement but before setImmediate dispatch.
process.stdout.write(JSON.stringify({id:result.id,state:result.state}));
process.exit(0);

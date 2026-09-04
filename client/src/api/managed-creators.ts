import { requestJson } from './http';
import type { ArchiveCatalogCreatorDetail } from '../types/api';

const root = '/api/admin/archive-catalog';
export type ManagedCreatorInput = {
  name:string; preference:'liked'|'kept'|null; rating:'R15'|'R18'|null; confirmDistinct:boolean;
};
function mutate<T>(path:string, method:string, body?:unknown) {
  return requestJson<T>(root+path, {method, headers:{'content-type':'application/json'}, body:body===undefined?undefined:JSON.stringify(body)});
}
export const createManagedCreator=(body:ManagedCreatorInput)=>mutate<ArchiveCatalogCreatorDetail>('/creators','POST',body);
export const updateManagedCreator=(id:number,body:ManagedCreatorInput)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}`,'PATCH',body);
export const addManagedAlias=(id:number,alias:string,confirmDistinct:boolean)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}/aliases`,'POST',{alias,confirmDistinct});
export const deleteManagedAlias=(id:number,aliasId:string)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}/aliases/${encodeURIComponent(aliasId)}`,'DELETE');
export const setManagedCreatorActive=(id:number,active:boolean)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}/${active?'restore':'deactivate'}`,'POST',{confirm:true});
export const linkManagedFolder=(folderId:number,creatorId:number)=>mutate<ArchiveCatalogCreatorDetail>(`/local-creator-folders/${folderId}/link`,'POST',{creatorId});
export const unlinkManagedFolder=(folderId:number)=>mutate<{folderId:number;creatorId:null}>(`/local-creator-folders/${folderId}/unlink`,'POST',{confirm:true});

import { requestJson } from './http';
import type { ArchiveCatalogCreatorDetail, LocalIngestDestinationPreference } from '../types/api';

const root = '/api/admin/archive-catalog';
export type ManagedCreatorInput = {
  name:string; preference:'liked'|'kept'|null; rating:'R15'|'R18'|null; confirmDistinct:boolean;
};
export type ManagedCreatorDeletionPreview = {
  creatorId:number; name:string; eligible:boolean;
  blockers:Array<{code:string;label:string;count:number}>;
  confirmationToken:string; removableAliases:number;
};
export type ManagedCreatorSavedState = {
  creator: ArchiveCatalogCreatorDetail;
  profileRevision: string;
  directoriesRevision: string;
  linkedFolderIds: number[];
  preferredLocalCreatorFolderId: number | null;
};
export type ManagedCreatorEditingState = ManagedCreatorSavedState & { destination: LocalIngestDestinationPreference };
export type ManagedCreatorProfileDraft = ManagedCreatorInput & { manualAliases: string[]; expectedRevision: string };
export type ManagedCreatorDirectoryDraft = {
  linkedFolderIds: number[];
  expectedRevision: string;
} & ({preferredGalleryFolderId: number | null; preferredLocalCreatorFolderId?: never}
  | {preferredLocalCreatorFolderId: number | null; preferredGalleryFolderId?: never});
function mutate<T>(path:string, method:string, body?:unknown) {
  return requestJson<T>(root+path, {method, headers:{'content-type':'application/json'}, body:body===undefined?undefined:JSON.stringify(body)});
}
export const createManagedCreator=(body:ManagedCreatorInput)=>mutate<ArchiveCatalogCreatorDetail>('/creators','POST',body);
export const fetchManagedCreatorEditingState=(id:number)=>requestJson<ManagedCreatorEditingState>(`${root}/creators/${id}/editing-state`);
export const saveManagedCreatorProfile=(id:number,body:ManagedCreatorProfileDraft)=>mutate<ManagedCreatorSavedState>(`/creators/${id}/profile-settings`,'PUT',body);
export const saveManagedCreatorDirectories=(id:number,body:ManagedCreatorDirectoryDraft)=>mutate<ManagedCreatorSavedState>(`/creators/${id}/directory-settings`,'PUT',body);
export const updateManagedCreator=(id:number,body:ManagedCreatorInput)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}`,'PATCH',body);
export const addManagedAlias=(id:number,alias:string,confirmDistinct:boolean)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}/aliases`,'POST',{alias,confirmDistinct});
export const deleteManagedAlias=(id:number,aliasId:string)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}/aliases/${encodeURIComponent(aliasId)}`,'DELETE');
export const setManagedCreatorActive=(id:number,active:boolean)=>mutate<ArchiveCatalogCreatorDetail>(`/creators/${id}/${active?'restore':'deactivate'}`,'POST',{confirm:true});
export const previewManagedCreatorDeletion=(id:number)=>requestJson<ManagedCreatorDeletionPreview>(`${root}/creators/${id}/deletion-preview`);
export const deleteUnusedManagedCreator=(id:number,confirmationToken:string)=>mutate<{deleted:true;creatorId:number}>(`/creators/${id}`,'DELETE',{confirm:true,confirmationToken});
export const linkManagedFolder=(folderId:number,creatorId:number)=>mutate<ArchiveCatalogCreatorDetail>(`/local-creator-folders/${folderId}/link`,'POST',{creatorId});
export const unlinkManagedFolder=(folderId:number)=>mutate<{folderId:number;creatorId:null}>(`/local-creator-folders/${folderId}/unlink`,'POST',{confirm:true});
export const fetchIngestDestination=(creatorId:number)=>requestJson<LocalIngestDestinationPreference>(`${root}/creators/${creatorId}/ingest-destination`);
export const setIngestDestination=(creatorId:number,localCreatorFolderId:number|null)=>mutate<LocalIngestDestinationPreference>(`/creators/${creatorId}/ingest-destination`,'PUT',{localCreatorFolderId});

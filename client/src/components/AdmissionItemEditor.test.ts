import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AdmissionItemEditor from './AdmissionItemEditor.vue';
import { admissionAction } from '../utils/admission-ui';
import type { AdmissionItem, AdmissionWork } from '../types/local-admission';

const work:AdmissionWork={workId:7,title:'Moon RED.Ver',catalogNo:'002',images:10,videos:0,thumbnailUrl:null,primaryLocalWorkId:11,localState:'indexed',originalDirectories:['Archive Moon RED.Ver'],sources:[],matchEvidence:{level:'similar',reasons:['标题有版本差异，仅作候选']}};
const item:AdmissionItem={key:'review',sourceRelativePath:'Moon',targetPath:'gallery/Moon',displayTitle:'Moon',group:'C',state:'preview',summary:{images:10,videos:0,other:0,bytes:100},candidates:[work],conflicts:[],ads:[],reviewIssues:['title_similar']};
const render=(value:AdmissionItem=item,locked=false)=>mount(AdmissionItemEditor,{props:{item:value,creatorId:1,peers:[],locked,acceptExistingVersion:true,modelValue:admissionAction(value,'defer')}});

describe('admission candidate review evidence',()=>{
  it.each(['No supported media found; nothing admitted','Failed to preview: No supported media found; nothing admitted'])('shows the historical draft conflict %s in Chinese with raw English only in technical details',raw=>{
    const wrapper=render({...item,group:'D',reviewIssues:['read_error'],conflicts:[raw,'target exists','目录身份需要核对'],summary:{images:0,videos:0,other:1,bytes:100}});
    expect(wrapper.get('[data-test=admission-error-message]').text()).toBe('目录中未找到支持入库的图片或视频，请核对文件格式');
    const detail=wrapper.get('[data-test=admission-error-detail]');
    expect(detail.text()).toContain(raw);expect(detail.attributes('open')).toBeUndefined();
    const main=wrapper.element.cloneNode(true) as HTMLElement;
    main.querySelectorAll('details').forEach(details=>details.remove());
    expect(main.textContent).toContain('目录中未找到支持入库的图片或视频，请核对文件格式');
    expect(main.textContent).not.toContain(raw);
    expect(wrapper.findAll('.warning').map(warning=>warning.text())).toEqual(['目标路径已占用，不能覆盖；请核对现有目录，不要仅靠改名消除提示。','目录身份需要核对']);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.unmount();
  });

  it('shows batch peers while deferred without selecting a relation, and permits independent manual handling',async()=>{
    const wrapper=render({...item,candidates:[],reviewIssues:['batch_candidate'],peerCandidates:[{sourceRelativePath:'Studio Series-123 V2',reasons:['同系列标记，仅供核对']}],peerCandidatesTruncated:true});
    expect(wrapper.text()).toContain('本批还有相关目录');
    expect(wrapper.text()).toContain('Studio Series-123 V2');
    expect(wrapper.text()).toContain('同系列标记，仅供核对');
    expect(wrapper.text()).toContain('本批候选超过展示上限');
    expect(wrapper.text()).toContain('希望保留两份');
    expect(wrapper.get('select').element.value).toBe('defer');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get('select').setValue('new');
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({action:'new',selectionOrigin:'manual',primary:false,acceptSourceIds:[]});
    wrapper.unmount();
  });
  it('shows similar evidence while deferred and only selects an existing Work after an explicit click',async()=>{
    const wrapper=render();
    expect(wrapper.get('select').element.value).toBe('defer');
    expect(wrapper.text()).toContain('标题有版本差异，仅作候选');
    expect(wrapper.text()).toContain('Archive Moon RED.Ver');
    expect(wrapper.text()).toContain('未比较媒体内容');
    expect(wrapper.text()).toContain('外站 NO 不作为作品身份');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get('[data-work-candidate="7"] button').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({action:'existing',workId:7,primary:false,acceptSourceIds:[],selectionOrigin:'manual'});
    expect(wrapper.emitted('select-work')?.[0]?.[0]).toEqual(work);
    wrapper.unmount();
  });
  it('allows an explicit same-title independent work and keeps a locked decision untouched',async()=>{
    const exact={...item,group:'B' as const,candidates:[{...work,matchEvidence:{level:'exact' as const,reasons:['展示标题精确一致']}}],reviewIssues:['title_exact' as const]};
    const wrapper=render(exact);
    expect(wrapper.text()).toContain('标题精确命中，不代表内容相同');
    await wrapper.get('select').setValue('new');
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({action:'new',displayTitle:'Moon'});
    wrapper.unmount();
    const locked=render(exact,true);
    await locked.get('[data-work-candidate="7"] button').trigger('click');
    expect(locked.emitted('update:modelValue')).toBeUndefined();locked.unmount();
  });
  it('distinguishes multiple matches, occupied targets, structure and partial candidate lists',()=>{
    const wrapper=render({...item,group:'D',reviewIssues:['multiple_candidates','target_conflict','structure'],candidatesTruncated:true,conflicts:['target exists'],structureWarnings:['多个媒体分支']});
    for(const text of ['存在多个已有作品候选','目标路径已占用，不会覆盖','目录结构需要核对','候选超过展示上限','多个媒体分支'])expect(wrapper.text()).toContain(text);
    expect(wrapper.text()).not.toContain('target exists');wrapper.unmount();
  });
  it('does not invent match strength for old drafts or assert that no match proves a new work',()=>{
    const old=render({...item,reviewIssues:undefined,candidates:[{...work,matchEvidence:undefined}]});
    expect(old.text()).toContain('历史候选，依据需重新核对');old.unmount();
    const unmatched=render({...item,group:'A',candidates:[],reviewIssues:[]});
    expect(unmatched.text()).toContain('不等于已证明从未收录');unmatched.unmount();
  });
});

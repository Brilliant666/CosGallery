import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AdmissionItemEditor from './AdmissionItemEditor.vue';
import { admissionAction } from '../utils/admission-ui';
import type { AdmissionItem, AdmissionWork } from '../types/local-admission';

const work:AdmissionWork={workId:7,title:'Moon RED.Ver',catalogNo:'002',images:10,videos:0,thumbnailUrl:null,primaryLocalWorkId:11,localState:'indexed',originalDirectories:['Archive Moon RED.Ver'],sources:[],matchEvidence:{level:'similar',reasons:['标题有版本差异，仅作候选']}};
const item:AdmissionItem={key:'review',sourceRelativePath:'Moon',targetPath:'gallery/Moon',displayTitle:'Moon',group:'C',state:'preview',summary:{images:10,videos:0,other:0,bytes:100},candidates:[work],conflicts:[],ads:[],reviewIssues:['title_similar']};
const render=(value:AdmissionItem=item,locked=false)=>mount(AdmissionItemEditor,{props:{item:value,creatorId:1,peers:[],locked,acceptExistingVersion:true,modelValue:admissionAction(value,'defer')}});

describe('admission candidate review evidence',()=>{
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

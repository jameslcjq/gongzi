// 共享渲染辅助
window.SH = (function(){
  const SKIP = window.SKIP_FIELDS || new Set(['全日制学历及专业','最高学历及专业','任教班级、学科、节数','工作履历','教师资格学段','教师资格学科','教师资格证书号码','教师资格定期注册有效期起止时间']);

  const FIELD_GROUPS = [
    { title: '基本信息', fields: ['单位全称','姓名','性别','身份证号码','民族','籍贯','政治面貌','入党时间_显示','人员性质','现住址','联系电话'] },
    { title: '入编与岗位', fields: ['本县入编时间_显示','岗位职务','任命单位','批复文号','在现单位任现职时间_显示','是否在岗','岗位','总周课时数','是否任班主任','不在岗原因','不在岗起始时间','现在何处'] },
    { title: '职称', fields: ['职称','职称学科','职称获得时间_显示'] },
    { title: '备注', fields: ['备注'] },
  ];
  const LABEL_MAP = {
    '入党时间_显示':'入党时间','本县入编时间_显示':'本县入编时间',
    '职称获得时间_显示':'职称获得时间','在现单位任现职时间_显示':'在现单位任现职时间'
  };
  const MONO_FIELDS = new Set(['身份证号码','联系电话','入党时间_显示','本县入编时间_显示','职称获得时间_显示','在现单位任现职时间_显示','序号']);

  function esc(s){ return String(s??'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function splitLines(v){ return String(v??'').split(/\n+/).map(x=>x.trim()).filter(Boolean); }
  function isEmpty(v){ return v===null||v===undefined||v===''; }

  function initial(name){ return name? name.slice(-2,-1) || name.slice(0,1) : ''; }

  function statusTag(r){
    return r['是否在岗']==='是'
      ? '<span class="tag green dot">在岗</span>'
      : r['是否在岗']==='否' ? '<span class="tag amber dot">不在岗</span>' : '<span class="tag gray">—</span>';
  }
  function titleTag(t){
    if(!t) return '<span class="muted">—</span>';
    let cls='blue';
    if(t.includes('高级')) cls='blue';
    else if(t.includes('一级')) cls='green';
    else if(t.includes('二级')||t.includes('三级')) cls='gray';
    return `<span class="tag ${cls}">${esc(t)}</span>`;
  }
  function eduTag(e){
    if(!e?.学历) return '<span class="muted">—</span>';
    return `<span class="tag gray">${esc(e.学历)}</span>`;
  }
  function partyTag(p){
    if(!p) return '<span class="muted">—</span>';
    if(p.includes('党员')) return `<span class="tag red">${esc(p)}</span>`;
    if(p.includes('团员')) return `<span class="tag blue">${esc(p)}</span>`;
    return `<span class="tag gray">${esc(p)}</span>`;
  }

  // detail panel
  function eduCard(title,e){
    return `<div class="edu-card"><h4>${esc(title)}</h4>
      <div class="row"><span class="k">学历</span><span class="v">${esc(e?.学历||'—')}</span>
      <span class="k">专业</span><span class="v">${esc(e?.专业||'—')}</span>
      <span class="k">院校</span><span class="v">${esc(e?.毕业院校||'—')}</span>
      <span class="k">毕业</span><span class="v mono">${esc(e?.毕业时间||'—')}</span></div></div>`;
  }
  function timeline(items){
    if(!items||!items.length) return '<div class="muted" style="font-size:12px">—</div>';
    return `<ul class="timeline">${items.map(x=>{
      const m = String(x).match(/^(\d{4})(\d{2})?\s+(.*)$/);
      if(m){ const t = m[2]?`${m[1]}-${m[2]}`:m[1]; return `<li><span class="when mono">${t}</span>${esc(m[3])}</li>`; }
      return `<li>${esc(x)}</li>`;
    }).join('')}</ul>`;
  }
  function qualTable(r){
    const a=splitLines(r['教师资格学段']), b=splitLines(r['教师资格学科']), c=splitLines(r['教师资格证书号码']), d=splitLines(r['教师资格定期注册有效期起止时间']);
    const n=Math.max(a.length,b.length,c.length,d.length);
    if(!n) return '<div class="muted" style="font-size:12px">—</div>';
    let rows='';
    for(let i=0;i<n;i++){
      rows+=`<tr><td>${esc(a[i]||'—')}</td><td>${esc(b[i]||'—')}</td><td class="mono">${esc(c[i]||'—')}</td><td class="mono">${esc(d[i]||'—')}</td></tr>`;
    }
    return `<table class="qual-table"><thead><tr><th>学段</th><th>学科</th><th>证书号码</th><th>注册有效期</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function teachingItems(r){
    const items = r['任教条目'] || splitLines(r['任教班级、学科、节数']);
    if(!items||!items.length) return '<div class="muted" style="font-size:12px">—</div>';
    return `<div class="line-list">${items.map(x=>`<div class="line-item mono">${esc(x)}</div>`).join('')}</div>`;
  }

  function kvField(r, key){
    const label = LABEL_MAP[key] || key;
    let val = r[key];
    if(isEmpty(val)) return `<div class="kv"><span class="k">${esc(label)}</span><span class="v muted">—</span></div>`;
    const monoCls = MONO_FIELDS.has(key) ? ' mono' : '';
    return `<div class="kv"><span class="k">${esc(label)}</span><span class="v${monoCls}">${esc(val)}</span></div>`;
  }

  function detailHtml(r){
    const tags = [];
    if(r.最高学历?.学历) tags.push(`<span class="tag gray">${esc(r.最高学历.学历)}</span>`);
    if(r.职称) tags.push(titleTag(r.职称));
    if(r['是否在岗']) tags.push(statusTag(r));
    if(r['政治面貌']) tags.push(partyTag(r['政治面貌']));

    const head = `<div class="person-head">
      <div class="avatar-lg">${esc(initial(r.姓名||''))}</div>
      <div style="flex:1;min-width:0">
        <h2>${esc(r.姓名||'')}<span style="font-weight:400;color:var(--text-3);font-size:13px;margin-left:10px">${esc(r['岗位职务']||'')}</span></h2>
        <div class="sub">${esc(r['身份证号码']||'')} · ${esc(r['单位全称']||'')}</div>
        <div class="tags">${tags.join('')}</div>
      </div>
    </div>`;

    const eduSec = `<div class="section">
      <h3 class="section-title">学历</h3>
      <div class="edu-grid">${eduCard('全日制',r.全日制学历)}${eduCard('最高学历',r.最高学历)}</div>
    </div>`;

    const careerSec = `<div class="section">
      <h3 class="section-title">工作履历</h3>
      ${timeline(r['工作履历条目']||splitLines(r['工作履历']))}
    </div>`;

    const qualSec = `<div class="section">
      <h3 class="section-title">教师资格</h3>
      ${qualTable(r)}
    </div>`;

    const teachSec = `<div class="section">
      <h3 class="section-title">任教</h3>
      ${teachingItems(r)}
    </div>`;

    const groupSec = (g) => {
      const items = g.fields.map(f=>kvField(r,f)).join('');
      return `<div class="section"><h3 class="section-title">${esc(g.title)}</h3><div class="kv-grid">${items}</div></div>`;
    };
    const basic = groupSec(FIELD_GROUPS[0]);
    const post = groupSec(FIELD_GROUPS[1]);
    const titleSec = groupSec(FIELD_GROUPS[2]);
    const remarkSec = groupSec(FIELD_GROUPS[3]);

    return head + basic + post + titleSec + eduSec + qualSec + teachSec + careerSec + remarkSec;
  }

  // CSV export
  function exportCSV(rows, filename){
    const cols = ['序号','单位全称','姓名','性别','身份证号码','民族','籍贯','政治面貌','入党时间_显示','人员性质','全日制学历及专业','最高学历及专业','本县入编时间_显示','职称','职称学科','职称获得时间_显示','岗位职务','是否在岗','岗位','总周课时数','是否任班主任','现住址','联系电话','工作履历'];
    const head = cols.map(c=>LABEL_MAP[c]||c);
    const lines = [head.join(',')];
    rows.forEach(r=>{
      lines.push(cols.map(c=>{
        let v = r[c]==null?'':String(r[c]).replace(/\n/g,' / ');
        if(/[",\n]/.test(v)) v = '"'+v.replace(/"/g,'""')+'"';
        return v;
      }).join(','));
    });
    const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || `教职工_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  // filter
  function filterRows(data, q, sex, status){
    q = (q||'').trim().toLowerCase();
    return data.filter(r=>{
      if(sex && r['性别']!==sex) return false;
      if(status && r['是否在岗']!==status) return false;
      if(!q) return true;
      const text = [r.姓名,r.身份证号码,r.职称,r.全日制学历?.专业,r.最高学历?.专业,r.岗位职务,r.联系电话,r.现住址,r.工作履历,r.单位全称].join(' ').toLowerCase();
      return text.includes(q);
    });
  }

  function highlight(text, q){
    if(!q || !text) return esc(text||'');
    const idx = String(text).toLowerCase().indexOf(q.toLowerCase());
    if(idx<0) return esc(text);
    const s = String(text);
    return esc(s.slice(0,idx))+'<mark>'+esc(s.slice(idx, idx+q.length))+'</mark>'+esc(s.slice(idx+q.length));
  }

  return { esc, splitLines, initial, statusTag, titleTag, eduTag, partyTag, detailHtml, exportCSV, filterRows, highlight };
})();

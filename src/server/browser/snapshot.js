// The page as Pi reads it (browser/page.ts), in one Runtime.evaluate: the visible controls, numbered, with the actual DOM
// nodes kept by id; the visible text (6,000 characters at most); and guards that tell, just before input, whether the
// page or the control changed since. Adapted from jev-ultrafast's snapshot.js (MIT, Copyright (c) 2026 Browser Use,
// https://github.com/browser-use/jev-ultrafast); credited in README.md.
(() => {
  if (!document.body) return null;
  const cache = window.__piBrowser ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const listed = e => safe(e) || e.type === 'password' || e.type === 'file';
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  // A control with no name (an icon): a name from what it shows or where it goes, so Pi can tell icons apart: a title
  // or tooltip inside it, an SVG's title or sprite name, a picture's file name, where a link goes, or an icon class.
  const plain = s => (s=(s||'').replace(/\.[a-z0-9]{2,4}$/i,'').replace(/^.*[#/]/,'').replace(/[-_.]+/g,' ')
    .replace(/\b(icons?|ico|svg|img|sprite|fa|mdi|bi)\b/gi,' ').replace(/\s+/g,' ').trim(),
    /^[a-z][a-z0-9 ]{1,40}$/i.test(s) && !/[0-9a-f]{6}|\d{3}/i.test(s) ? s : '');
  const hint = e => {
    const inner=e.querySelector('[title],[data-tooltip],[data-title]');
    const titled=e.getAttribute('data-tooltip') || e.getAttribute('data-title') ||
      (inner && (inner.getAttribute('title') || inner.getAttribute('data-tooltip') || inner.getAttribute('data-title')));
    if (titled && titled.trim()) return titled;
    const svg=e.querySelector('svg title')?.textContent?.trim();
    if (svg) return svg;
    const use=e.querySelector('use'), sprite=plain(use?.getAttribute('href') || use?.getAttribute('xlink:href'));
    if (sprite) return sprite;
    const img=e.tagName==='IMG' ? e : e.querySelector('img'), src=(img?.getAttribute('src')||'').split('?')[0];
    if (src && !src.startsWith('data:') && plain(src)) return 'image '+plain(src);
    const href=e.getAttribute('href');
    if (href && !/^(javascript:|#$)/i.test(href)) {
      try {
        const u=new URL(href,location.href);
        return 'to '+(u.host===location.host ? (u.pathname+u.search).slice(0,80) : (u.host+u.pathname).slice(0,80));
      } catch {}
    }
    for (const n of [e,...e.querySelectorAll('[class]')].slice(0,4))
      for (const c of n.classList) if (/icon|btn|button|close|menu|search|share|like|vote|back|next|prev|play|more/i.test(c) && plain(c)) return plain(c);
    return '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel',''].includes(e.type)) return 'textbox';
      if (e.type==='password') return 'password';
      if (e.type==='file') return 'file';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.type==='password' ? null : e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  // An option or menu item out of the window inside a list with its own scroll area that is in it (a Radix select of
  // 40 options): listed, as a click scrolls it into view (PP-116).
  const inList = e => {
    if (!['option','menuitem','menuitemradio'].includes(role(e))) return false;
    for (let s=e.parentElement; s && s!==document.body && s!==document.documentElement; s=s.parentElement) {
      if (s.scrollHeight<=s.clientHeight+1 && s.scrollWidth<=s.clientWidth+1) continue;
      const o=getComputedStyle(s);
      if (!/(auto|scroll|overlay|hidden)/.test(o.overflowY+' '+o.overflowX)) continue;
      const q=s.getBoundingClientRect();
      return q.bottom>0 && q.top<innerHeight && q.right>0 && q.left<innerWidth;
    }
    return false;
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!listed(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0) continue;
    if ((x<0 || y<0 || x>=innerWidth || y>=innerHeight) && !inList(e)) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:(name(e)||hint(e)||rname).replace(/\s+/g,' ').trim().slice(0,200),
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,option:o.label,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', ')});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton','password'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value=e.type==='password' ? '' : e.type==='file' ? [...e.files].map(f=>f.name).join(', ') : 'value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value:value.slice(0,200)});
      if (editable) actions.push({...base,kind:'click',value:value.slice(0,200)});
    }
  }
  // Things clickable by their look or script only (a div with a pointer cursor or a click handler, as pop-ups and app
  // banners often are): the outermost such element in view, with a name, not inside or around a control listed above.
  // As browser-use reads pages, which looks at the cursor too.
  const listedNodes=new Set(actions.map(a=>cache.nodes.get(a.node)));
  let looked=0;
  for (const e of document.body.querySelectorAll('div,span,li,p,img,svg,label,section,article,[onclick],[tabindex]')) {
    if (++looked>4000 || actions.length>=300) break;
    if (listedNodes.has(e) || e.closest(selector) || e.querySelector(selector)) continue;
    const r=e.getBoundingClientRect();
    if (r.width<8 || r.height<8 || r.bottom<=0 || r.right<=0 || r.top>=innerHeight || r.left>=innerWidth) continue;
    if (r.width*r.height>innerWidth*innerHeight*0.5) continue;
    const tab=e.getAttribute('tabindex');
    const clickable=e.hasAttribute('onclick') || (tab!==null && tab!=='-1') || getComputedStyle(e).cursor==='pointer';
    if (!clickable || !visible(e)) continue;
    const parent=e.parentElement;
    if (parent && parent!==document.body && getComputedStyle(parent).cursor==='pointer' && !e.hasAttribute('onclick')) continue;
    const label=(name(e)||hint(e)).replace(/\s+/g,' ').trim().slice(0,200);
    if (!label) continue;
    const x=r.x+r.width/2, y=r.y+r.height/2;
    if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    listedNodes.add(e);
    actions.push({node:identity(e),role:'clickable',label,rect:{x:r.x,y:r.y,w:r.width,h:r.height},kind:'click',value:''});
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted=Math.max(0,actions.length-250);
  actions.splice(250);
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted};
})()

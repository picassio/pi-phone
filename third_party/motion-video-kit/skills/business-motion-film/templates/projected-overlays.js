// HTML/SVG overlays driven by projected Three.js anchors. Pure functions of local time (seek-safe).
// Labels: an evenly spaced column of callouts with leader lines to moving 3D points.
// Pins: photo cards that pop out of a 3D point, dock into a rail, then fly to exact target rectangles in the next scene.
// anchors = [{id, x, y}] in screen pixels (from vector.project(camera)).
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const ease=x=>{x=clamp(x);return x*x*(3-2*x)};
const out=x=>1-Math.pow(1-clamp(x),3);
const lerp=(a,b,t)=>a+(b-a)*t;
const SVG='http://www.w3.org/2000/svg';
function line(svg){const p=document.createElementNS(SVG,'path'),c=document.createElementNS(SVG,'circle'),r=document.createElementNS(SVG,'circle');r.setAttribute('r',16);r.setAttribute('class','pin-ring');c.setAttribute('r',7);svg.append(p,r,c);return{p,c,r};}

// items: [[id, number, label], ...]
export function mountLabels(root,items){
 const svg=document.createElementNS(SVG,'svg');svg.setAttribute('class','ov-lines');root.appendChild(svg);
 return items.map(([id,n,name])=>{const d=document.createElement('div');d.className='ov-label';d.innerHTML=`<b>${n}</b><span>${name}</span>`;root.appendChild(d);return{id,d,...line(svg)};});
}
export function updateLabels(els,t,anchors,start=1.25){
 const rows=anchors.map((a,i)=>({a,i,ly:a.y})).sort((p,q)=>p.ly-q.ly);const y0=rows[0].ly,y1=Math.max(rows.at(-1).ly,y0+3*84),gap=(y1-y0)/3;rows.forEach((r,k)=>r.ly=y0+k*gap);
 rows.forEach(({a,i,ly})=>{const e=els.find(x=>x.id===a.id);const on=out((t-start-i*.11)/.32);const lx=Math.max(a.x+90,1500);
  e.d.style.transform=`translate(${lx+14}px,${ly-18}px)`;e.d.style.opacity=on;e.d.style.clipPath=`inset(0 ${100-100*on}% 0 0)`;
  e.p.setAttribute('d',`M${a.x} ${a.y}L${a.x+(lx-a.x)*.45} ${ly}L${lx} ${ly}`);e.p.style.strokeDasharray=700;e.p.style.strokeDashoffset=700*(1-on);
  for(const c of [e.c,e.r]){c.setAttribute('cx',a.x);c.setAttribute('cy',a.y);}e.c.style.opacity=on;e.r.style.opacity=on*(1-ease((t-start-i*.11-.2)/.5));e.r.setAttribute('r',8+22*ease((t-start-i*.11)/.7));});
}

// photos: [{id, n, name, src, at, target:[x,y,w,h], offset:[dx,dy]}]
// at = local time the card pops out; target = exact rectangle in the next scene; offset = card position relative to its pin.
export function mountPins(root,photos){
 const svg=document.createElementNS(SVG,'svg');svg.setAttribute('class','ov-lines');root.appendChild(svg);
 return photos.map(({id,n,name,src,at,target,offset})=>{const d=document.createElement('div');d.className='pin-card';d.innerHTML=`<img src="${src}"><span><b>${n}</b>${name}</span>`;root.appendChild(d);return{id,at,target,offset,d,...line(svg)};});
}
export function updatePins(els,t,anchors,{handoff=3.45,D=4.1}={}){
 const W=440,H=248,RW=384,RH=216;
 anchors.forEach((a,i)=>{const e=els.find(x=>x.id===a.id);const on=out((t-e.at)/.38);
  const [ox,oy]=e.offset;let px=Math.min(Math.max(a.x+ox,70),1420-W),py=Math.min(Math.max(a.y+oy,70),1080-H-70);
  const dock=out((t-e.at-.72)/.42),leave=out((t-handoff-i*.06)/(D-handoff-.12));
  const rail=[1466,150+i*262,RW,RH];const [tx,ty,tw,th]=e.target;
  let x=lerp(px,rail[0],dock),y=lerp(py,rail[1],dock),w=lerp(W,RW,dock),h=lerp(H,RH,dock);
  x=lerp(x,tx,leave);y=lerp(y,ty,leave);w=lerp(w,tw,leave);h=lerp(h,th,leave);
  e.d.style.transform=`translate(${x}px,${y}px) scale(${lerp(.72,1,on)})`;e.d.style.width=w+'px';e.d.style.height=h+'px';e.d.style.opacity=out((t-e.at)/.12);
  e.d.querySelector('span').style.opacity=1-leave;e.d.style.boxShadow=`0 22px 50px rgba(0,0,0,${(.4*(1-leave)).toFixed(3)})`;
  const lineOn=on*(1-dock);const cx=x+w/2,cy=y+h;
  e.p.setAttribute('d',`M${a.x} ${a.y}L${cx} ${cy}`);e.p.style.opacity=lineOn;for(const c of [e.c,e.r]){c.setAttribute('cx',a.x);c.setAttribute('cy',a.y);}e.c.style.opacity=lineOn;
  e.r.style.opacity=lineOn*(1-ease((t-e.at-.15)/.55));e.r.setAttribute('r',8+26*ease((t-e.at)/.7));});
}
export const OVERLAY_CSS=`.ov-lines{position:absolute;inset:0;width:1920px;height:1080px;overflow:visible;z-index:4;pointer-events:none}.ov-lines path{fill:none;stroke:currentColor;stroke-width:2}.ov-lines circle{fill:#d9ef71;stroke:#0a211d;stroke-width:3}.ov-lines .pin-ring{fill:none;stroke:#d9ef71;stroke-width:2}
.ov-label{position:absolute;left:0;top:0;z-index:5;display:flex;align-items:center;gap:12px;color:#0a211d;font-size:26px;font-weight:650;letter-spacing:-.3px;white-space:nowrap}.ov-label b{font-size:17px;letter-spacing:2px;color:#f4f0e5;background:#0a211d;padding:6px 9px;font-weight:600}
.pin-card{position:absolute;left:0;top:0;z-index:6;transform-origin:50% 100%;overflow:hidden;background:#0a211d;box-shadow:0 22px 50px #0006}.pin-card img{width:100%;height:100%;object-fit:cover;display:block}.pin-card span{position:absolute;left:12px;top:12px;background:#f4f0e5;color:#0a211d;font-size:19px;font-weight:650;padding:6px 10px;display:flex;gap:10px;letter-spacing:.3px}.pin-card span b{color:#51703a}`;

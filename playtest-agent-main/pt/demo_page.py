"""The demo page reads one run shape for both recorded and live play."""

PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playtest Agent live</title><style>
:root{--bg:#10141a;--fg:#e8edf3;--dim:#93a1b3;--card:#1a212b;--ok:#4cc38a;--bad:#ef6b6b;--accent:#f2b84b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:16px}header{margin:4px 0 16px}header h1{font-size:32px;line-height:1.2;margin:0 0 6px}header p{margin:0 0 12px}h2{font-size:20px}h3{font-size:18px}
header ol{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;list-style:none;margin:0;padding:0}header li{background:var(--card);border-radius:10px;padding:10px 12px;min-width:0}
@media(max-width:600px){header h1{font-size:26px}header ol{grid-template-columns:1fr}}
img{max-width:100%;height:auto;border-radius:8px;background:#000;display:block}
.card{background:var(--card);border-radius:10px;padding:16px;margin:12px 0;min-width:0}
p,h2,h3,blockquote,a{overflow-wrap:anywhere}.dim{color:var(--dim)}blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid var(--accent);white-space:pre-wrap}
form,nav{display:flex;gap:12px;flex-wrap:wrap}input,select{max-width:100%;min-width:0;padding:10px;border-radius:8px;border:1px solid #334;background:#0c1016;color:var(--fg);font:inherit}input{flex:1 1 140px}
button{padding:10px 16px;border-radius:8px;border:0;background:var(--accent);color:#111;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5}
a{color:var(--accent)}#why{color:var(--bad);min-height:1.2em}.ok{color:var(--ok)}.no{color:var(--bad)}[hidden]{display:none}
#look{white-space:pre-wrap}#links{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}
</style></head><body><main>
<header><h1>Playtest Agent</h1><p>Watch a recorded run or start a live bug hunt with the passcode.</p>
<ol id="intro-steps"><li><b>Play</b>: it sees a screenshot and presses keys.</li><li><b>Report</b>: it writes what it expected and what it saw.</li><li><b>Replay</b>: each report runs twice on a fresh game.</li><li><b>Judge</b>: a second model must quote what it saw.</li></ol></header>
<div class="card"><form id="f"><input id="code" type="password" placeholder="Passcode" aria-label="Passcode" autocomplete="off"><button>Start a bug hunt</button></form><div id="why" role="status"></div></div>
<label for="picker">Recorded run</label> <select id="picker"></select> <button id="live" hidden>Watch live run</button>
<section class="card" aria-label="Step view"><h2 id="title">Recorded run</h2><p id="head" aria-live="polite"></p>
<img id="shot" alt="Game screen" hidden><p id="look" hidden></p><div id="words" hidden><b>Agent's words</b><blockquote id="quote"></blockquote></div>
<p id="actions" hidden></p><p id="cost"></p><nav aria-label="Step controls"><button id="previous">Previous</button><button id="next">Next</button><button id="play">Play</button></nav></section>
<section aria-label="Bug reports"><h2>Bug reports</h2><button id="allReports" type="button">Show all reports</button><div id="cards"></div></section>
<section class="card" id="summary" aria-label="Run summary"></section>
<nav id="links" aria-label="Run links"></nav><p id="out" class="dim" aria-live="polite"></p>
<script>
const el=id=>document.getElementById(id);
let run=null,st={},mode='replay',current=0,timer=null,follow=true,lastLive=null,cardText='',allReports=false;
async function j(u,o){const r=await fetch(u,o);return r.json()}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function stop(){clearInterval(timer);timer=null;el('play').textContent='Play'}
function optional(id,value){el(id).textContent=value;el(id).hidden=!value}
function show(index){
 const steps=run?.steps||[];current=Math.max(0,Math.min(Math.max(0,steps.length-1),index));
 const step=steps[current];el('title').textContent=run?.title||'Recorded run';
 el('head').textContent=step?'Step '+step.step:'Waiting for the first step';
 el('shot').hidden=!step?.shot;if(step?.shot&&el('shot').getAttribute('src')!==step.shot)el('shot').src=step.shot;
 optional('look',step?.look?'LOOK: '+step.look:'');el('words').hidden=!step?.words;el('quote').textContent=step?.words||'';
 optional('actions',step?.actions?'Actions: '+step.actions:'');el('cost').textContent=step?'Running cost: $'+step.cost_total.toFixed(5):'';
 el('previous').disabled=!step||current===0;el('next').disabled=!step||current===steps.length-1;el('play').disabled=!steps.length;
 if(current===steps.length-1&&mode==='replay')stop();
}
function render(){
 show(current);
 const visibleCards=mode==='live'||allReports?(run.cards||[]):(run.cards||[]).filter(c=>Number(c.step)<=Number(run.steps?.[current]?.step??-1));
 const html=visibleCards.map(c=>'<article class="card"><h3>'+esc(c.title)+'</h3><p><b>Expected:</b> '+esc(c.expected)+'</p><p><b>Seen:</b> '+esc(c.seen)+'</p><p>Filed at step '+esc(c.step)+'</p>'+
  (c.strip?'<a href="'+esc(c.strip)+'" target="_blank" rel="noopener"><img src="'+esc(c.strip)+'" alt="Evidence frames"></a>':'')+(c.replays?'<p>'+esc(c.replays)+'</p>':'')+
  (c.replays?'<p class="'+(c.judge_yes?'ok':'no')+'">Judge: '+(c.judge_yes?'Yes':'No')+'</p>'+(c.judge_quote?'<blockquote>'+esc(c.judge_quote)+'</blockquote>':''):'<p class="dim">Waiting for checks</p>')+'</article>').join('');
 if(cardText!==html){el('cards').innerHTML=html;cardText=html}
 const s=run.summary;el('summary').innerHTML='<h2>Whole run totals</h2><p>Bugs filed: '+s.filed+'</p><p>Confirmed: '+s.confirmed+'</p><p>Set aside: '+s.set_aside+'</p><p>Steps: '+s.steps+'</p><p>Total cost: $'+s.cost_usd.toFixed(5)+'</p><p>Run time: '+s.seconds+' seconds</p>';
 const labels={report:'Full report page',console:'Console page',repo:'Repository'};
 el('links').replaceChildren();Object.entries(run.links).forEach(([key,url])=>{
  if(!url||!(/^(https?:\/\/|\/)/.test(url)))return;
  const a=document.createElement('a');a.href=url;a.textContent=labels[key];el('links').append(a);
 });
}
async function loadReplay(name){stop();mode='replay';allReports=false;const data=await j('/replay/'+encodeURIComponent(name));if(mode!=='replay')return;run=data;current=0;render();if(run.steps.length>1){el('play').textContent='Pause';timer=setInterval(()=>{if(current>=run.steps.length-1){stop();return}show(current+1);render()},700)}}
function watchLive(){if(!st.run)return;stop();mode='live';follow=true;run=st;current=Math.max(0,run.steps.length-1);render()}
el('picker').onchange=()=>loadReplay(el('picker').value);el('live').onclick=watchLive;
el('previous').onclick=()=>{stop();follow=false;show(current-1);render()};
el('next').onclick=()=>{stop();show(current+1);follow=current===run.steps.length-1;render()};
el('allReports').onclick=()=>{allReports=!allReports;el('allReports').textContent=allReports?'Show reports for this step':'Show all reports';render()};
el('play').onclick=()=>{if(timer){stop();return}if(current===run.steps.length-1)show(0);el('play').textContent='Pause';timer=setInterval(()=>{show(current+1);if(current===run.steps.length-1)stop()},700)};
async function poll(){
 st=await j('/status');el('live').hidden=!st.run;
 if(st.run&&st.run!==lastLive){lastLive=st.run;if(st.state!=='done')watchLive()}
 if(mode==='live'&&st.run){run=st;if(follow)current=Math.max(0,run.steps.length-1);render()}
 el('out').textContent=(st.state==='checking'?'Checking each report: replay twice, then the judge model. ': '')+(st.reason||'');
 return st;
}
el('f').onsubmit=async e=>{e.preventDefault();el('why').textContent='';try{const r=await j('/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:el('code').value})});if(!r.ok)el('why').textContent=r.reason;await poll()}catch(e){el('why').textContent='The demo could not be reached. Try again.'}};
(async()=>{try{await poll();for(const name of st.replays||[]){const option=document.createElement('option');option.value=name;option.textContent=name;el('picker').append(option)}if(mode==='replay'&&st.replays?.length)await loadReplay(st.replays[0]);setInterval(()=>poll().catch(()=>{el('out').textContent='The demo could not be reached. Try again.'}),1000)}catch(e){el('out').textContent='The demo could not be reached. Try again.'}})();
</script></main></body></html>"""

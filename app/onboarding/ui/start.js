const $=s=>document.querySelector(s),{t,apply}=window.AHI_I18N;
let lang='en';
async function start(){
  $('#start-actions').hidden=true;$('#start-kicker').textContent=t(lang,'start.kicker');$('#start-title').textContent=t(lang,'start.title');$('#start-reason').textContent=t(lang,'start.reason');
  try{await window.ahi.invoke('start');}// on success the app replaces this page with AHI itself
  catch(error){
    $('#start-kicker').textContent=t(lang,'start.failKicker');$('#start-title').textContent=t(lang,'start.failTitle');
    $('#start-reason').textContent=error.message||t(lang,'start.failReason');
    $('#start-actions').hidden=false;$('#retry').focus();
  }
}
$('#retry').addEventListener('click',start);
$('#setup').addEventListener('click',()=>window.ahi.invoke('setup'));
// The owner's language (saved from AHI's Settings, or chosen in setup) before anything is shown.
window.ahi.invoke('language').catch(()=>'en').then(l=>{lang=l;apply(lang,document);start();});

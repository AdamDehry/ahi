const $=s=>document.querySelector(s);
async function start(){
  $('#start-actions').hidden=true;$('#start-kicker').textContent='ONE MOMENT';$('#start-title').textContent='Starting AHI…';$('#start-reason').textContent='Your agents will be right with you.';
  try{await window.ahi.invoke('start');}// on success the app replaces this page with AHI itself
  catch(error){
    $('#start-kicker').textContent='AHI DID NOT START';$('#start-title').textContent='AHI couldn’t start this time.';
    $('#start-reason').textContent=error.message||'Something went wrong. Its log is in AHI_OS/logs/ahi-server.log.';
    $('#start-actions').hidden=false;$('#retry').focus();
  }
}
$('#retry').addEventListener('click',start);
$('#setup').addEventListener('click',()=>window.ahi.invoke('setup'));
start();

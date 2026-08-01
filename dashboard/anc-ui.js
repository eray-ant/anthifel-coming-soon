
/* Anthifel Dashboard — ortak mantık.
   ŞİFREYİ DEĞİŞTİRMEK İÇİN: aşağıdaki PASS değerini düzenleyin.
   Not: Bu istemci tarafı bir ön kapıdır (statik site). Caydırıcıdır ama gerçek
   güvenlik değildir — bu panelde hassas veri SAKLAMAYIN. */
var PASS = 'anthifel2026';

function store(){ try{ return window.localStorage; }catch(e){ return null; } }
function ses(){ try{ return window.sessionStorage; }catch(e){ return null; } }

function guard(){
  var s = ses();
  if (!s || s.getItem('anc_dash_auth') !== '1'){ location.replace('index.html'); }
}
function doLogin(){
  var el = document.getElementById('pw');
  if (el.value === PASS){
    var s = ses(); if (s) s.setItem('anc_dash_auth','1');
    location.href = 'overview.html';
  } else {
    document.getElementById('err').textContent = 'Şifre yanlış.';
    el.value=''; el.focus();
  }
  return false;
}
function logout(){
  var s = ses(); if (s) s.removeItem('anc_dash_auth');
  location.href = 'index.html';
}
/* checklist persist */
function ckInit(page){
  var st = store(); if (!st) return;
  document.querySelectorAll('.ck input[type=checkbox]').forEach(function(c,i){
    var k = 'anc_ck_' + page + '_' + (c.id || i);
    if (st.getItem(k) === '1'){ c.checked = true; c.closest('li').classList.add('done'); }
    c.addEventListener('change', function(){
      st.setItem(k, c.checked ? '1' : '0');
      c.closest('li').classList.toggle('done', c.checked);
    });
  });
}
function today(){
  var d=new Date(), g=['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
  var a=['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  return d.getDate()+' '+a[d.getMonth()]+' '+d.getFullYear()+', '+g[d.getDay()];
}
function daysTo(iso){ return Math.ceil((new Date(iso) - new Date())/86400000); }
function copyText(id, btn){
  var t = document.getElementById(id).textContent;
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function(){
    var o = btn.textContent; btn.textContent='Kopyalandı ✓'; setTimeout(function(){btn.textContent=o;},1500);
  }).catch(function(){ window.prompt('Kopyalayın:', t); });
}

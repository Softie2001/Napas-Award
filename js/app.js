import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore, collection, onSnapshot, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { FIREBASE_CONFIG, EVENT_TIME } from "./config.js";

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

const WORKER_URL = "https://crimson-wave-afc5.quadrisubomi.workers.dev";
const FALLBACK_CATEGORIES = [
  "Most Fashionable","Best Class Governor","Miss Accountancy","Mrs Accountancy",
"Best Player of the Year","Ambassador of the Year","Best Graphics Designer of the Year",
"Best Course Rep of the Year","Best Entrepreneur of the Year","Best Clerk of the Year",
"Best Assistant Governor of the Year","Miss Ebony","Best Outspoken","Best Coach of the Year",
"Best Content Creator of the Year","Best Blogger of the Year"
];
const VOTE_OPTIONS = [1,5,10,20,50,100];

let contestants = [];
let settings = { votingOpen:true, votePrice:100 };
let selectedContestant = null;
let selectedVotes = null;

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const naira = n => "₦" + Number(n || 0).toLocaleString("en-NG");

function updateCountdown(){
  const left = Math.max(0, Math.floor((new Date(EVENT_TIME).getTime()-Date.now())/1000));
  const d=Math.floor(left/86400), h=Math.floor((left%86400)/3600), m=Math.floor((left%3600)/60), s=left%60;
  $("#days").textContent=String(d).padStart(2,"0");
  $("#hours").textContent=String(h).padStart(2,"0");
  $("#minutes").textContent=String(m).padStart(2,"0");
  $("#seconds").textContent=String(s).padStart(2,"0");
}
updateCountdown(); setInterval(updateCountdown,1000);

function categoryName(c){ return String(c?.category || c?.awardCategory || c?.eventCategory || "Award Category"); }
function contestantImage(c){ return c.photo || c.image || c.photoUrl || c.imageUrl || ""; }
function contestantMeta(c){
  return [c.department || c.course, c.level || c.className, c.matricNumber || c.matric].filter(Boolean);
}
function filtered(){
  const q=($("#search").value||"").trim().toLowerCase();
  const cat=$("#category").value||"";
  return contestants.filter(c=>{
    const text=[c.name,c.nickname,categoryName(c),...contestantMeta(c)].join(" ").toLowerCase();
    return (!q || text.includes(q)) && (!cat || categoryName(c)===cat);
  });
}

function renderCategories(){
  const cats=[...new Set(contestants.map(categoryName).filter(Boolean))];
  const list=cats.length?cats:FALLBACK_CATEGORIES;
  $("#category").innerHTML='<option value="">All categories</option>'+list.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("#pills").innerHTML='<button class="active" type="button" data-cat="">All</button>'+list.map(c=>`<button type="button" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
  $("#categoryGrid").innerHTML=list.map(c=>{
    const count=contestants.filter(x=>categoryName(x)===c).length;
    return `<a class="category-card" href="#voting" data-category-link="${esc(c)}">
      <span><i class="category-icon">🏆</i><span><strong>${esc(c)}</strong><small>${count} nominee${count===1?"":"s"}</small></span></span>
      <span class="category-arrow">›</span>
    </a>`;
  }).join("");
  document.querySelectorAll("#pills button").forEach(b=>b.addEventListener("click",()=>{
    $("#category").value=b.dataset.cat||"";
    document.querySelectorAll("#pills button").forEach(x=>x.classList.remove("active")); b.classList.add("active");
    renderContestants();
  }));
  document.querySelectorAll("[data-category-link]").forEach(a=>a.addEventListener("click",()=>{
    $("#category").value=a.dataset.categoryLink;
    document.querySelectorAll("#pills button").forEach(x=>x.classList.toggle("active",x.dataset.cat===a.dataset.categoryLink));
    setTimeout(renderContestants,0);
  }));
}

function renderContestants(){
  const list=filtered();
  $("#empty").classList.toggle("hidden",list.length>0);
  $("#grid").innerHTML=list.map(c=>{
    const img=contestantImage(c);
    const meta=contestantMeta(c);
    return `<article class="card">
      <div class="card-photo">${img?`<img src="${esc(img)}" alt="${esc(c.name||"Contestant")}" loading="lazy">`:`<div class="empty-icon">◯</div>`}</div>
      <div class="card-body">
        <span class="card-cat">${esc(categoryName(c))}</span>
        <h3 class="card-name">${esc(c.name||"Unnamed contestant")}</h3>
        <div class="card-sub">${esc(c.nickname||"")}</div>
        <div class="card-info">${meta.map(x=>`<span>${esc(x)}</span>`).join("")}</div>
        <div class="card-votes">${Number(c.votes||0).toLocaleString()} votes</div>
        <button class="btn btn-purple contestant-vote" type="button" data-id="${esc(c.id)}" ${settings.votingOpen?"":"disabled"}>${settings.votingOpen?"Vote Now":"Voting Closed"} <span>→</span></button>
      </div>
    </article>`;
  }).join("");
  document.querySelectorAll(".contestant-vote").forEach(b=>b.addEventListener("click",()=>openModal(b.dataset.id)));
  renderLeaderboard();
}

function renderLeaderboard(){
  const top=[...contestants].sort((a,b)=>Number(b.votes||0)-Number(a.votes||0)).slice(0,10);
  $("#leaderboard").innerHTML=top.length?top.map((c,i)=>`<div class="leader-row">
    <span class="rank ${i<3?"top":""}">${i+1}</span>
    <div><div class="leader-name">${esc(c.name||"Unnamed")}</div><div class="leader-meta">${esc(categoryName(c))}</div></div>
    <strong class="leader-votes">${Number(c.votes||0).toLocaleString()}</strong>
  </div>`).join(""):`<div class="empty">Results will appear here.</div>`;
}

function setStatus(){
  const open=!!settings.votingOpen;
  $("#status").textContent=open?"Voting Open":"Voting Closed";
  $("#status").style.color=open?"var(--success)":"var(--danger)";
  $("#heroStatus").textContent=open?"OPEN NOW":"CLOSED";
  $("#price").textContent=naira(settings.votePrice);
}

function openModal(id){
  selectedContestant=contestants.find(c=>c.id===id);
  if(!selectedContestant) return;
  selectedVotes=null;
  $("#modalCategory").textContent=categoryName(selectedContestant);
  $("#modalName").textContent=selectedContestant.name||"Contestant";
  $("#modalMeta").textContent=[...contestantMeta(selectedContestant),`${Number(selectedContestant.votes||0).toLocaleString()} votes`].filter(Boolean).join(" • ");
  const img=contestantImage(selectedContestant);
  $("#modalPhoto").innerHTML=img?`<img src="${esc(img)}" alt="${esc(selectedContestant.name||"Contestant")}">`:"";
  $("#modalPrice").textContent=naira(settings.votePrice);
  $("#customVotes").value="";
  $("#voterName").value=""; $("#voterEmail").value=""; $("#voterPhone").value="";
  $("#paymentError").classList.add("hidden"); $("#paymentError").textContent="";
  $("#voteOptions").innerHTML=VOTE_OPTIONS.map(v=>`<button type="button" class="vote-option" data-votes="${v}">${v.toLocaleString()}<span>${naira(v*settings.votePrice)}</span></button>`).join("");
  document.querySelectorAll(".vote-option").forEach(b=>b.addEventListener("click",()=>{
    selectedVotes=Number(b.dataset.votes); $("#customVotes").value="";
    document.querySelectorAll(".vote-option").forEach(x=>x.classList.remove("selected")); b.classList.add("selected"); updateTotal();
  }));
  updateTotal();
  $("#voteModal").classList.remove("hidden"); $("#voteModal").setAttribute("aria-hidden","false"); document.body.classList.add("modal-open");
}

function updateTotal(){
  const custom=Number($("#customVotes").value);
  if(custom>0){ selectedVotes=Math.floor(custom); document.querySelectorAll(".vote-option").forEach(x=>x.classList.remove("selected")); }
  const amount=selectedVotes?selectedVotes*Number(settings.votePrice):0;
  $("#modalTotal").textContent=naira(amount);
  $("#pay").disabled=!(settings.votingOpen&&selectedContestant&&selectedVotes>0&&$("#voterName").value.trim()&&$("#voterEmail").value.trim());
}

function closeModal(){
  $("#voteModal").classList.add("hidden"); $("#voteModal").setAttribute("aria-hidden","true"); document.body.classList.remove("modal-open"); selectedContestant=null; selectedVotes=null;
}
$("#modalClose").addEventListener("click",closeModal);
$("#voteModal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeModal()});
["#customVotes","#voterName","#voterEmail","#voterPhone"].forEach(s=>$(s).addEventListener("input",updateTotal));

async function startPayment(){
  const error=$("#paymentError"); error.classList.add("hidden");
  if(!selectedContestant||!selectedVotes) return;
  const name=$("#voterName").value.trim(), email=$("#voterEmail").value.trim(), phone=$("#voterPhone").value.trim();
  if(!name||!email){ error.textContent="Please enter your name and email."; error.classList.remove("hidden"); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ error.textContent="Please enter a valid email address."; error.classList.remove("hidden"); return; }
  const btn=$("#pay"); btn.disabled=true; btn.innerHTML="Preparing secure payment...";
  try{
    const res=await fetch(`${WORKER_URL}/initialize`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      contestantId:selectedContestant.id,votes:selectedVotes,email,name,phone,callbackUrl:`${location.origin}${location.pathname}?payment=return`
    })});
    const data=await res.json();
    if(!res.ok||!data.success) throw new Error(data.error||"Unable to start payment.");
    sessionStorage.setItem("napas_pending_payment",JSON.stringify({reference:data.reference,contestantId:selectedContestant.id,votes:selectedVotes,name,email,phone}));
    location.href=data.authorization_url;
  }catch(e){
    error.textContent=e.message||"Unable to start payment. Please try again.";
    error.classList.remove("hidden"); btn.disabled=false; btn.innerHTML="Continue to Payment <span>→</span>";
  }
}
$("#pay").addEventListener("click",startPayment);

async function handlePaymentReturn(){
  const params=new URLSearchParams(location.search);
  const reference=params.get("reference")||params.get("trxref");
  if(!reference) return;
  const pending=JSON.parse(sessionStorage.getItem("napas_pending_payment")||"null");
  if(!pending) return;
  history.replaceState({},document.title,location.pathname+location.hash);
  try{
    const res=await fetch(`${WORKER_URL}/verify`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      reference,contestantId:pending.contestantId,votes:pending.votes,email:pending.email,name:pending.name,phone:pending.phone
    })});
    const data=await res.json();
    if(!res.ok||!data.success) throw new Error(data.error||"Payment verification failed.");
    sessionStorage.removeItem("napas_pending_payment");
    $("#successText").textContent=`${pending.votes.toLocaleString()} vote${pending.votes===1?"":"s"} have been added to the selected contestant.`;
    $("#successVotes").textContent=Number(data.newTotalVotes||0).toLocaleString();
    $("#successReference").textContent=reference;
    $("#successModal").classList.remove("hidden");
  }catch(e){
    sessionStorage.removeItem("napas_pending_payment");
    alert(e.message||"Payment verification failed. If money was deducted, keep your Paystack reference and contact NAPAS.");
  }
}
$("#successClose").addEventListener("click",()=>$("#successModal").classList.add("hidden"));
$("#successResults").addEventListener("click",()=>$("#successModal").classList.add("hidden"));

$("#search").addEventListener("input",renderContestants);
$("#category").addEventListener("change",()=>{
  document.querySelectorAll("#pills button").forEach(x=>x.classList.toggle("active",(x.dataset.cat||"")===$("#category").value));
  renderContestants();
});
$("#menuBtn").addEventListener("click",()=>{
  const open=$("#mobileMenu").style.display==="block"; $("#mobileMenu").style.display=open?"none":"block"; $("#menuBtn").setAttribute("aria-expanded",String(!open));
});
document.querySelectorAll("#mobileMenu a").forEach(a=>a.addEventListener("click",()=>{$("#mobileMenu").style.display="none";$("#menuBtn").setAttribute("aria-expanded","false")}));

async function loadSettings(){
  try{
    const snap=await getDoc(doc(db,"settings","voting"));
    if(snap.exists()) settings={...settings,...snap.data()};
  }catch(e){console.warn("Voting settings unavailable; using safe defaults.",e)}
  setStatus(); renderCategories(); renderContestants();
}

onSnapshot(collection(db,"contestants"),snap=>{
  contestants=snap.docs.map(d=>({id:d.id,...d.data()})).filter(c=>c.published!==false);
  renderCategories(); renderContestants();
},err=>console.error("Contestants listener error:",err));

loadSettings();
handlePaymentReturn();

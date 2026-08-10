import{initializeApp}from"https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import{getAuth,signInWithEmailAndPassword,onAuthStateChanged,signOut}from"https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import{getFirestore,collection,doc,setDoc,updateDoc,deleteDoc,onSnapshot,serverTimestamp,query,orderBy}from"https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import{FIREBASE_CONFIG,CLOUDINARY_CLOUD_NAME,CLOUDINARY_UPLOAD_PRESET,ADMIN_EMAIL}from"../js/config.js";

const appFirebase=initializeApp(FIREBASE_CONFIG);
const auth=getAuth(appFirebase);
const db=getFirestore(appFirebase);

const C=[
"Most Fashionable","Best Class Governor","Miss Accountancy","Mrs Accountancy",
"Best Player of the Year","Ambassador of the Year","Best Graphics Designer of the Year",
"Best Course Rep of the Year","Best Entrepreneur of the Year","Best Clerk of the Year",
"Best Assistant Governor of the Year","Miss Ebony","Best Outspoken","Best Coach of the Year",
"Best Content Creator of the Year","Best Blogger of the Year","Best Brand of the Year"
];

let list=[];
let settings={votingOpen:true,votePrice:100};
let unsubscribeStarted=false;

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const esc=x=>String(x??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));

function showPage(page){
  $$(".page").forEach(x=>x.classList.toggle("active",x.id===page));
  $$(".nav-item").forEach(x=>x.classList.toggle("active",x.dataset.page===page));
  const btn=$(`.nav-item[data-page="${page}"]`);
  if(btn) $("#title").textContent=btn.textContent.trim();
  $("#sidebar").classList.remove("open");
}

$("#loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  $("#error").textContent="";
  try{
    const u=await signInWithEmailAndPassword(auth,$("#email").value.trim(),$("#password").value);
    if(!u.user.email||u.user.email.toLowerCase()!==ADMIN_EMAIL.toLowerCase()){
      await signOut(auth);
      throw new Error("This account is not authorised for the NAPAS admin portal.");
    }
  }catch(e){
    $("#error").textContent=e.code==="auth/invalid-credential"?"Incorrect email or password.":e.message;
  }
});

onAuthStateChanged(auth,u=>{
  const allowed=u?.email?.toLowerCase()===ADMIN_EMAIL.toLowerCase();
  $("#login").classList.toggle("hidden",!!allowed);
  $("#app").classList.toggle("hidden",!allowed);
  if(allowed){
    $("#who").textContent=u.email;
    if(!unsubscribeStarted) start();
  }
});

$("#logout").onclick=()=>signOut(auth);
$("#menu").onclick=()=>$("#sidebar").classList.toggle("open");
$$(".nav-item").forEach(b=>b.onclick=()=>showPage(b.dataset.page));
$$("[data-page-jump]").forEach(b=>b.onclick=()=>showPage(b.dataset.pageJump));

function start(){
  unsubscribeStarted=true;

  $("#cat").innerHTML=C.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
  $("#filter").innerHTML=`<option value="">All categories</option>`+C.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
  renderCategories();

  onSnapshot(collection(db,"contestants"),snap=>{
    list=snap.docs.map(d=>({id:d.id,...d.data()}));
    render();
  },err=>$("#error").textContent=err.message);

  onSnapshot(doc(db,"settings","voting"),snap=>{
    if(snap.exists()) settings={...settings,...snap.data()};
    $("#vp").value=settings.votePrice||100;
    renderVotingState();
    render();
  });

  onSnapshot(query(collection(db,"adminActivity"),orderBy("createdAt","desc")),snap=>{
    $("#logs").innerHTML=snap.docs.slice(0,20).map(d=>{
      const x=d.data();
      return `<p><strong>${esc(x.message||"Administrative activity")}</strong><br><small>${x.createdAt?.toDate?x.createdAt.toDate().toLocaleString():"Recent activity"}</small></p>`;
    }).join("")||`<p>No recent activity.</p>`;
  },()=>$("#logs").innerHTML="<p>Activity is not available yet.</p>");
}

function renderCategories(){
  $("#cats").innerHTML=C.map((c,i)=>{
    const count=list.filter(x=>x.category===c).length;
    return `<article class="category-card"><span class="number">${String(i+1).padStart(2,"0")}</span><h3>${esc(c)}</h3><p>${count} contestant${count===1?"":"s"} registered</p></article>`;
  }).join("");
}

function render(){
  const q=$("#search").value.toLowerCase().trim();
  const c=$("#filter").value;
  const st=$("#state").value;

  const filtered=list.filter(n=>{
    const text=`${n.name||""} ${n.id||""}`.toLowerCase();
    const published=n.published!==false;
    return (!q||text.includes(q))&&(!c||n.category===c)&&(!st||(st==="yes"?published:!published));
  });

  $("#rows").innerHTML=filtered.map(n=>`
    <tr>
      <td>${n.photo?`<img src="${esc(n.photo)}" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:10px">`:""}<strong>${esc(n.name)}</strong></td>
      <td>${esc(n.category)}</td>
      <td>${esc(n.id)}</td>
      <td><span class="pill ${n.published!==false?"published":"unpublished"}">${n.published!==false?"Published":"Unpublished"}</span></td>
      <td><strong>${Number(n.votes||0).toLocaleString()}</strong></td>
      <td><div class="actions"><button data-edit="${esc(n.id)}">Edit</button><button data-pub="${esc(n.id)}">${n.published!==false?"Unpublish":"Publish"}</button><button data-del="${esc(n.id)}">Delete</button></div></td>
    </tr>`).join("")||`<tr><td colspan="6">No contestants match your search.</td></tr>`;

  $$("[data-edit]").forEach(b=>b.onclick=()=>openEdit(list.find(n=>n.id===b.dataset.edit)));
  $$("[data-pub]").forEach(b=>b.onclick=async()=>{
    const n=list.find(x=>x.id===b.dataset.pub); if(!n)return;
    await updateDoc(doc(db,"contestants",n.id),{published:n.published===false,updatedAt:serverTimestamp()});
    await audit(`${n.published===false?"Published":"Unpublished"} contestant: ${n.name}`);
  });
  $$("[data-del]").forEach(b=>b.onclick=async()=>{
    const n=list.find(x=>x.id===b.dataset.del); if(!n)return;
    if(confirm(`Delete ${n.name}? This removes the contestant record.`)){
      await deleteDoc(doc(db,"contestants",n.id));
      await audit(`Deleted contestant: ${n.name}`);
    }
  });

  const total=list.reduce((s,n)=>s+Number(n.votes||0),0);
  $("#sc").textContent=list.length.toLocaleString();
  $("#sv").textContent=total.toLocaleString();
  $("#sr").textContent=`₦${(total*(settings.votePrice||100)).toLocaleString()}`;
  $("#ss").textContent=settings.votingOpen?"OPEN":"CLOSED";
  $("#statusHint").textContent=settings.votingOpen?"Voters can vote":"Voting is currently closed";
  $("#headerStatus").textContent=settings.votingOpen?"Voting open":"Voting closed";

  const ranked=list.slice().sort((a,b)=>Number(b.votes||0)-Number(a.votes||0));
  $("#result").innerHTML=ranked.map((n,i)=>`<tr><td><strong>#${i+1}</strong></td><td>${esc(n.name)}</td><td>${esc(n.category)}</td><td><strong>${Number(n.votes||0).toLocaleString()}</strong></td></tr>`).join("")||`<tr><td colspan="4">No contestants yet.</td></tr>`;
  $("#topContestants").innerHTML=ranked.slice(0,5).map((n,i)=>`<div class="top-row"><span class="rank">#${i+1}</span><div><strong>${esc(n.name)}</strong><small>${esc(n.category)}</small></div><strong>${Number(n.votes||0).toLocaleString()}</strong></div>`).join("")||"<p>No contestants yet.</p>";
  renderCategories();
}

function renderVotingState(){
  const open=!!settings.votingOpen;
  $("#votingStateCard").className=`voting-state ${open?"open":"closed"}`;
  $("#votingStateLabel").textContent=open?"Voting is OPEN":"Voting is CLOSED";
  $("#votingStateDescription").textContent=open?"Voters can submit votes.":"The public voting page should not accept votes.";
  $("#toggle").textContent=open?"Close voting":"Open voting";
}

async function audit(message){
  try{await setDoc(doc(db,"adminActivity",crypto.randomUUID()),{message,createdAt:serverTimestamp(),admin:auth.currentUser?.email||ADMIN_EMAIL});}catch{}
}

function openEdit(n){
  $("#modal").classList.remove("hidden");
  $("#mt").textContent=n?"Edit contestant":"Add contestant";
  $("#eid").value=n?.id||"";
  $("#name").value=n?.name||"";
  $("#cid").value=n?.id||`CNT-${String(list.length+1).padStart(4,"0")}`;
  $("#cat").value=n?.category||C[0];
  $("#nick").value=n?.nickname||"";
  $("#bio").value=n?.bio||"";
  $("#pub").checked=n?n.published!==false:true;
  $("#preview").innerHTML=n?.photo?`<img src="${esc(n.photo)}" alt="Current photo">`:"";
  $("#photo").value="";
}

function closeModal(){$("#modal").classList.add("hidden")}
$("#add").onclick=()=>openEdit();
$("#x").onclick=closeModal;
$("#cancel").onclick=closeModal;
$("#modal").addEventListener("click",e=>{if(e.target.id==="modal")closeModal()});
$("#search").oninput=render;
$("#filter").onchange=render;
$("#state").onchange=render;

$("#toggle").onclick=async()=>{
  settings.votingOpen=!settings.votingOpen;
  await setDoc(doc(db,"settings","voting"),{votingOpen:settings.votingOpen,votePrice:Number(settings.votePrice||100),updatedAt:serverTimestamp()},{merge:true});
  await audit(`Voting ${settings.votingOpen?"opened":"closed"}`);
};

$("#save").onclick=async()=>{
  const price=Math.max(1,Number($("#vp").value)||100);
  settings.votePrice=price;
  await setDoc(doc(db,"settings","voting"),{votePrice:price,votingOpen:!!settings.votingOpen,updatedAt:serverTimestamp()},{merge:true});
  await audit(`Vote price updated to ₦${price.toLocaleString()}`);
  alert("Voting price saved.");
};

$("#form").onsubmit=async e=>{
  e.preventDefault();
  try{
    const old=list.find(n=>n.id===$("#eid").value);
    let photoUrl=old?.photo||"";
    const f=$("#photo").files[0];

    if(f){
      if(!CLOUDINARY_CLOUD_NAME||!CLOUDINARY_UPLOAD_PRESET) throw new Error("Cloudinary settings are missing from js/config.js.");
      const fd=new FormData();
      fd.append("file",f);
      fd.append("upload_preset",CLOUDINARY_UPLOAD_PRESET);
      const r=await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,{method:"POST",body:fd});
      if(!r.ok)throw new Error("Image upload failed.");
      photoUrl=(await r.json()).secure_url;
    }

    const id=$("#cid").value.trim();
    if(!id)throw new Error("Contestant ID is required.");

    const data={
      name:$("#name").value.trim(),
      category:$("#cat").value,
      nickname:$("#nick").value.trim(),
      bio:$("#bio").value.trim(),
      photo:photoUrl,
      published:$("#pub").checked,
      updatedAt:serverTimestamp()
    };

    if(old){
      // votes are intentionally not written by the admin portal.
      await setDoc(doc(db,"contestants",old.id),data,{merge:true});
      await audit(`Updated contestant: ${data.name}`);
    }else{
      await setDoc(doc(db,"contestants",id),{...data,id,votes:0,createdAt:serverTimestamp()});
      await audit(`Added contestant: ${data.name}`);
    }

    closeModal();
  }catch(err){alert(err.message)}
};

$("#export").onclick=()=>{
  const ranked=list.slice().sort((a,b)=>Number(b.votes||0)-Number(a.votes||0));
  const rows=[["Rank","Name","Category","Votes"],...ranked.map((n,i)=>[i+1,n.name,n.category,n.votes||0])];
  const csv=rows.map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="napas-results.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

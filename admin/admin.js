import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  FIREBASE_CONFIG,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_UPLOAD_PRESET,
  ADMIN_EMAIL
} from "../js/config.js";


/* =========================================================
   FIREBASE
========================================================= */

const appFirebase = initializeApp(FIREBASE_CONFIG);

const auth = getAuth(appFirebase);

const db = getFirestore(appFirebase);


/* =========================================================
   CATEGORIES
========================================================= */

const CATEGORIES = [
  "Most Fashionable",
  "Best Class Governor",
  "Miss Accountancy",
  "Mrs Accountancy",
  "Best Player of the Year",
  "Ambassador of the Year",
  "Best Graphics Designer of the Year",
  "Best Course Rep of the Year",
  "Best Entrepreneur of the Year",
  "Best Clerk of the Year",
  "Best Assistant Governor of the Year",
  "Miss Ebony",
  "Best Outspoken",
  "Best Coach of the Year",
  "Best Content Creator of the Year",
  "Best Blogger of the Year",
  "Best Brand of the Year"
];


/* =========================================================
   STATE
========================================================= */

let contestants = [];

let settings = {
  votingOpen: true,
  votePrice: 100
};

let listenersStarted = false;


/* =========================================================
   HELPERS
========================================================= */

const $ = selector =>
  document.querySelector(selector);

const $$ = selector =>
  [...document.querySelectorAll(selector)];


function escapeHTML(value) {

  return String(value ?? "").replace(
    /[&<>"']/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[character])
  );

}


/* =========================================================
   PAGE NAVIGATION
========================================================= */

function showPage(page) {

  $$(".page").forEach(section => {

    section.classList.toggle(
      "active",
      section.id === page
    );

  });


  $$(".nav-item").forEach(button => {

    button.classList.toggle(
      "active",
      button.dataset.page === page
    );

  });


  const activeButton =
    document.querySelector(
      `.nav-item[data-page="${page}"]`
    );


  if (activeButton) {

    $("#title").textContent =
      activeButton.textContent.trim();

  }


  $("#sidebar").classList.remove("open");

}


/* =========================================================
   LOGIN
========================================================= */

const loginForm =
  $("#loginForm");

const loginButton =
  $("#loginButton");

const loginError =
  $("#error");


loginForm.addEventListener(
  "submit",
  async event => {

    event.preventDefault();


    loginError.textContent = "";


    const email =
      $("#email").value.trim();

    const password =
      $("#password").value;


    if (!email || !password) {

      loginError.textContent =
        "Enter your email and password.";

      return;

    }


    loginButton.disabled = true;

    loginButton.textContent =
      "Signing in...";


    try {

      const credential =
        await signInWithEmailAndPassword(
          auth,
          email,
          password
        );


      const signedInEmail =
        credential.user.email
          ?.trim()
          .toLowerCase();


      const allowedEmail =
        ADMIN_EMAIL
          .trim()
          .toLowerCase();


      if (
        !signedInEmail ||
        signedInEmail !== allowedEmail
      ) {

        await signOut(auth);

        throw new Error(
          "This account is not authorised for the NAPAS admin portal."
        );

      }


      /*
       * Firebase has authenticated the administrator.
       * onAuthStateChanged() will now open the dashboard.
       */

    }

    catch (error) {

      console.error(
        "Admin login error:",
        error
      );


      if (
        error.code ===
        "auth/invalid-credential"
      ) {

        loginError.textContent =
          "Incorrect email or password.";

      }

      else if (
        error.code ===
        "auth/user-not-found"
      ) {

        loginError.textContent =
          "No Firebase admin account exists with this email.";

      }

      else if (
        error.code ===
        "auth/wrong-password"
      ) {

        loginError.textContent =
          "Incorrect password.";

      }

      else if (
        error.code ===
        "auth/invalid-email"
      ) {

        loginError.textContent =
          "Enter a valid email address.";

      }

      else if (
        error.code ===
        "auth/too-many-requests"
      ) {

        loginError.textContent =
          "Too many failed attempts. Please wait and try again.";

      }

      else {

        loginError.textContent =
          error.message ||
          "Unable to sign in.";

      }

    }

    finally {

      loginButton.disabled = false;

      loginButton.textContent =
        "Sign in securely";

    }

  }
);


/* =========================================================
   AUTH STATE
========================================================= */

onAuthStateChanged(
  auth,
  user => {

    if (!user) {

      $("#login").classList.remove(
        "hidden"
      );

      $("#app").classList.add(
        "hidden"
      );

      return;

    }


    const signedInEmail =
      user.email
        ?.trim()
        .toLowerCase();


    const allowedEmail =
      ADMIN_EMAIL
        .trim()
        .toLowerCase();


    if (
      signedInEmail !==
      allowedEmail
    ) {

      signOut(auth);

      return;

    }


    /*
     * Correct administrator.
     */

    $("#login").classList.add(
      "hidden"
    );

    $("#app").classList.remove(
      "hidden"
    );


    $("#who").textContent =
      user.email;


    if (!listenersStarted) {

      startAdminDashboard();

    }

  }
);


/* =========================================================
   LOGOUT
========================================================= */

$("#logout").addEventListener(
  "click",
  async () => {

    await signOut(auth);

    $("#password").value = "";

  }
);


/* =========================================================
   NAVIGATION EVENTS
========================================================= */

$("#menu").addEventListener(
  "click",
  () => {

    $("#sidebar").classList.toggle(
      "open"
    );

  }
);


$$(".nav-item").forEach(
  button => {

    button.addEventListener(
      "click",
      () => {

        showPage(
          button.dataset.page
        );

      }
    );

  }
);


$$("[data-page-jump]").forEach(
  button => {

    button.addEventListener(
      "click",
      () => {

        showPage(
          button.dataset.pageJump
        );

      }
    );

  }
);


/* =========================================================
   START DASHBOARD
========================================================= */

function startAdminDashboard() {

  listenersStarted = true;


  $("#cat").innerHTML =
    CATEGORIES
      .map(
        category =>
          `<option value="${escapeHTML(category)}">
            ${escapeHTML(category)}
          </option>`
      )
      .join("");


  $("#filter").innerHTML =
    `<option value="">
      All categories
    </option>` +
    CATEGORIES
      .map(
        category =>
          `<option value="${escapeHTML(category)}">
            ${escapeHTML(category)}
          </option>`
      )
      .join("");


  renderCategories();


  /* =======================================================
     CONTESTANTS
  ====================================================== */

  onSnapshot(
    collection(
      db,
      "contestants"
    ),

    snapshot => {

      contestants =
        snapshot.docs.map(
          snapshotDocument => ({
            id:
              snapshotDocument.id,

            ...snapshotDocument.data()
          })
        );


      render();

    },

    error => {

      console.error(
        "Contestants listener error:",
        error
      );

    }
  );


  /* =======================================================
     VOTING SETTINGS
  ====================================================== */

  onSnapshot(
    doc(
      db,
      "settings",
      "voting"
    ),

    snapshot => {

      if (snapshot.exists()) {

        settings = {
          ...settings,
          ...snapshot.data()
        };

      }


      $("#vp").value =
        settings.votePrice || 100;


      renderVotingState();

      render();

    },

    error => {

      console.error(
        "Voting settings error:",
        error
      );

    }
  );


  /* =======================================================
     ACTIVITY
  ====================================================== */

  const activityQuery =
    query(
      collection(
        db,
        "adminActivity"
      ),
      orderBy(
        "createdAt",
        "desc"
      )
    );


  onSnapshot(
    activityQuery,

    snapshot => {

      $("#logs").innerHTML =
        snapshot.docs
          .slice(0, 20)
          .map(
            documentSnapshot => {

              const data =
                documentSnapshot.data();


              const date =
                data.createdAt?.toDate
                  ? data.createdAt
                      .toDate()
                      .toLocaleString()
                  : "Recent activity";


              return `
                <p>
                  <strong>
                    ${escapeHTML(
                      data.message ||
                      "Administrative activity"
                    )}
                  </strong>

                  <br>

                  <small>
                    ${escapeHTML(date)}
                  </small>
                </p>
              `;

            }
          )
          .join("") ||
        "<p>No recent activity.</p>";

    },

    () => {

      $("#logs").innerHTML =
        "<p>Activity is not available yet.</p>";

    }
  );

}


/* =========================================================
   CATEGORIES
========================================================= */

function renderCategories() {

  $("#cats").innerHTML =
    CATEGORIES
      .map(
        (category, index) => {

          const count =
            contestants.filter(
              contestant =>
                contestant.category ===
                category
            ).length;


          return `
            <article class="category-card">

              <span class="number">
                ${String(index + 1).padStart(2, "0")}
              </span>

              <h3>
                ${escapeHTML(category)}
              </h3>

              <p>
                ${count}
                contestant${count === 1 ? "" : "s"}
                registered
              </p>

            </article>
          `;

        }
      )
      .join("");

}


/* =========================================================
   MAIN RENDER
========================================================= */

function render() {

  const search =
    $("#search").value
      .toLowerCase()
      .trim();


  const category =
    $("#filter").value;


  const state =
    $("#state").value;


  const filtered =
    contestants.filter(
      contestant => {

        const text =
          `${contestant.name || ""}
           ${contestant.id || ""}`
            .toLowerCase();


        const published =
          contestant.published !== false;


        return (
          (!search ||
            text.includes(search)) &&

          (!category ||
            contestant.category ===
              category) &&

          (!state ||
            (
              state === "yes"
                ? published
                : !published
            ))
        );

      }
    );


  $("#rows").innerHTML =
    filtered
      .map(
        contestant => {

          const published =
            contestant.published !== false;


          return `
            <tr>

              <td>
                <strong>
                  ${escapeHTML(
                    contestant.name ||
                    "Unnamed contestant"
                  )}
                </strong>
              </td>

              <td>
                ${escapeHTML(
                  contestant.category ||
                  ""
                )}
              </td>

              <td>
                ${escapeHTML(
                  contestant.id
                )}
              </td>

              <td>

                <span
                  class="pill ${
                    published
                      ? "published"
                      : "unpublished"
                  }"
                >
                  ${
                    published
                      ? "Published"
                      : "Unpublished"
                  }
                </span>

              </td>

              <td>
                <strong>
                  ${Number(
                    contestant.votes || 0
                  ).toLocaleString()}
                </strong>
              </td>

              <td>

                <div class="actions">

                  <button
                    type="button"
                    data-edit="${escapeHTML(
                      contestant.id
                    )}"
                  >
                    Edit
                  </button>

                  <button
                    type="button"
                    data-pub="${escapeHTML(
                      contestant.id
                    )}"
                  >
                    ${
                      published
                        ? "Unpublish"
                        : "Publish"
                    }
                  </button>

                  <button
                    type="button"
                    data-del="${escapeHTML(
                      contestant.id
                    )}"
                  >
                    Delete
                  </button>

                </div>

              </td>

            </tr>
          `;

        }
      )
      .join("") ||
    `
      <tr>
        <td colspan="6">
          No contestants match your search.
        </td>
      </tr>
    `;


  $$("[data-edit]").forEach(
    button => {

      button.onclick = () => {

        const contestant =
          contestants.find(
            item =>
              item.id ===
              button.dataset.edit
          );


        if (contestant) {

          openEdit(contestant);

        }

      };

    }
  );


  $$("[data-pub]").forEach(
    button => {

      button.onclick = async () => {

        const contestant =
          contestants.find(
            item =>
              item.id ===
              button.dataset.pub
          );


        if (!contestant) {
          return;
        }


        await updateDoc(
          doc(
            db,
            "contestants",
            contestant.id
          ),
          {
            published:
              contestant.published === false,

            updatedAt:
              serverTimestamp()
          }
        );


        await audit(
          `${
            contestant.published === false
              ? "Published"
              : "Unpublished"
          } contestant: ${
            contestant.name
          }`
        );

      };

    }
  );


  $$("[data-del]").forEach(
    button => {

      button.onclick = async () => {

        const contestant =
          contestants.find(
            item =>
              item.id ===
              button.dataset.del
          );


        if (!contestant) {
          return;
        }


        if (
          confirm(
            `Delete ${contestant.name}? This removes the contestant record.`
          )
        ) {

          await deleteDoc(
            doc(
              db,
              "contestants",
              contestant.id
            )
          );


          await audit(
            `Deleted contestant: ${contestant.name}`
          );

        }

      };

    }
  );


  /* =======================================================
     STATS
  ====================================================== */

  const totalVotes =
    contestants.reduce(
      (total, contestant) =>
        total +
        Number(
          contestant.votes || 0
        ),
      0
    );


  $("#sc").textContent =
    contestants.length.toLocaleString();


  $("#sv").textContent =
    totalVotes.toLocaleString();


  $("#sr").textContent =
    `₦${(
      totalVotes *
      Number(
        settings.votePrice || 100
      )
    ).toLocaleString()}`;


  $("#ss").textContent =
    settings.votingOpen
      ? "OPEN"
      : "CLOSED";


  $("#statusHint").textContent =
    settings.votingOpen
      ? "Voters can vote"
      : "Voting is currently closed";


  $("#headerStatus").textContent =
    settings.votingOpen
      ? "Voting open"
      : "Voting closed";


  /* =======================================================
     RESULTS
  ====================================================== */

  const ranked =
    contestants
      .slice()
      .sort(
        (a, b) =>
          Number(b.votes || 0) -
          Number(a.votes || 0)
      );


  $("#result").innerHTML =
    ranked
      .map(
        (contestant, index) => `
          <tr>

            <td>
              <strong>
                #${index + 1}
              </strong>
            </td>

            <td>
              ${escapeHTML(
                contestant.name
              )}
            </td>

            <td>
              ${escapeHTML(
                contestant.category
              )}
            </td>

            <td>
              <strong>
                ${Number(
                  contestant.votes || 0
                ).toLocaleString()}
              </strong>
            </td>

          </tr>
        `
      )
      .join("") ||
    `
      <tr>
        <td colspan="4">
          No contestants yet.
        </td>
      </tr>
    `;


  $("#topContestants").innerHTML =
    ranked
      .slice(0, 5)
      .map(
        (contestant, index) => `
          <div class="top-row">

            <span class="rank">
              #${index + 1}
            </span>

            <div>

              <strong>
                ${escapeHTML(
                  contestant.name
                )}
              </strong>

              <small>
                ${escapeHTML(
                  contestant.category
                )}
              </small>

            </div>

            <strong>
              ${Number(
                contestant.votes || 0
              ).toLocaleString()}
            </strong>

          </div>
        `
      )
      .join("") ||
    "No contestants yet.";


  renderCategories();

}


/* =========================================================
   VOTING STATE
========================================================= */

function renderVotingState() {

  const open =
    !!settings.votingOpen;


  $("#votingStateCard").className =
    `voting-state ${
      open
        ? "open"
        : "closed"
    }`;


  $("#votingStateLabel").textContent =
    open
      ? "Voting is OPEN"
      : "Voting is CLOSED";


  $("#votingStateDescription").textContent =
    open
      ? "Voters can submit votes."
      : "The public voting page should not accept votes.";


  $("#toggle").textContent =
    open
      ? "Close voting"
      : "Open voting";

}


/* =========================================================
   AUDIT LOG
========================================================= */

async function audit(message) {

  try {

    await setDoc(
      doc(
        db,
        "adminActivity",
        crypto.randomUUID()
      ),
      {
        message,
        createdAt:
          serverTimestamp(),
        admin:
          auth.currentUser?.email ||
          ADMIN_EMAIL
      }
    );

  }

  catch {

    // Activity logging must not
    // stop the admin operation.

  }

}


/* =========================================================
   CONTESTANT MODAL
========================================================= */

function openEdit(contestant) {

  $("#modal")
    .classList
    .remove("hidden");


  $("#mt").textContent =
    contestant
      ? "Edit contestant"
      : "Add contestant";


  $("#eid").value =
    contestant?.id || "";


  $("#name").value =
    contestant?.name || "";


  $("#cid").value =
    contestant?.id ||
    `CNT-${String(
      contestants.length + 1
    ).padStart(4, "0")}`;


  $("#cat").value =
    contestant?.category ||
    CATEGORIES[0];


  $("#nick").value =
    contestant?.nickname || "";


  $("#bio").value =
    contestant?.bio || "";


  $("#pub").checked =
    contestant
      ? contestant.published !== false
      : true;


  $("#preview").innerHTML =
    contestant?.photo
      ? `
        <img
          src="${escapeHTML(
            contestant.photo
          )}"
          alt="Current contestant photo"
        >
      `
      : "";


  $("#photo").value = "";

}


/* =========================================================
   MODAL CLOSE
========================================================= */

function closeModal() {

  $("#modal")
    .classList
    .add("hidden");

}


$("#add").onclick =
  () => openEdit();


$("#x").onclick =
  closeModal;


$("#cancel").onclick =
  closeModal;


$("#modal").addEventListener(
  "click",
  event => {

    if (
      event.target.id ===
      "modal"
    ) {

      closeModal();

    }

  }
);


/* =========================================================
   FILTERS
========================================================= */

$("#search").oninput =
  render;


$("#filter").onchange =
  render;


$("#state").onchange =
  render;


/* =========================================================
   VOTING TOGGLE
========================================================= */

$("#toggle").onclick =
  async () => {

    settings.votingOpen =
      !settings.votingOpen;


    await setDoc(
      doc(
        db,
        "settings",
        "voting"
      ),
      {
        votingOpen:
          settings.votingOpen,

        votePrice:
          Number(
            settings.votePrice ||
            100
          ),

        updatedAt:
          serverTimestamp()

      },
      {
        merge: true
      }
    );


    await audit(
      `Voting ${
        settings.votingOpen
          ? "opened"
          : "closed"
      }`
    );

  };


/* =========================================================
   SAVE VOTE PRICE
========================================================= */

$("#save").onclick =
  async () => {

    const price =
      Math.max(
        1,
        Number(
          $("#vp").value
        ) || 100
      );


    settings.votePrice =
      price;


    await setDoc(
      doc(
        db,
        "settings",
        "voting"
      ),
      {
        votePrice:
          price,

        votingOpen:
          !!settings.votingOpen,

        updatedAt:
          serverTimestamp()

      },
      {
        merge: true
      }
    );


    await audit(
      `Vote price updated to ₦${price.toLocaleString()}`
    );


    alert(
      "Voting price saved."
    );

  };


/* =========================================================
   CONTESTANT SAVE
========================================================= */

$("#form").onsubmit =
  async event => {

    event.preventDefault();


    try {

      const old =
        contestants.find(
          contestant =>
            contestant.id ===
            $("#eid").value
        );


      let photoUrl =
        old?.photo || "";


      const file =
        $("#photo").files[0];


      if (file) {

        if (
          !CLOUDINARY_CLOUD_NAME ||
          !CLOUDINARY_UPLOAD_PRESET
        ) {

          throw new Error(
            "Cloudinary settings are missing from js/config.js."
          );

        }


        const formData =
          new FormData();


        formData.append(
          "file",
          file
        );


        formData.append(
          "upload_preset",
          CLOUDINARY_UPLOAD_PRESET
        );


        const response =
          await fetch(
            `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
            {
              method: "POST",
              body: formData
            }
          );


        if (!response.ok) {

          throw new Error(
            "Image upload failed."
          );

        }


        const uploaded =
          await response.json();


        photoUrl =
          uploaded.secure_url;

      }


      const id =
        $("#cid").value.trim();


      if (!id) {

        throw new Error(
          "Contestant ID is required."
        );

      }


      const data = {

        name:
          $("#name").value.trim(),

        category:
          $("#cat").value,

        nickname:
          $("#nick").value.trim(),

        bio:
          $("#bio").value.trim(),

        photo:
          photoUrl,

        published:
          $("#pub").checked,

        updatedAt:
          serverTimestamp()

      };


      if (old) {

        /*
         * IMPORTANT:
         * Do not modify votes here.
         */

        await setDoc(
          doc(
            db,
            "contestants",
            old.id
          ),
          data,
          {
            merge: true
          }
        );


        await audit(
          `Updated contestant: ${data.name}`
        );

      }

      else {

        await setDoc(
          doc(
            db,
            "contestants",
            id
          ),
          {
            ...data,
            id,
            votes: 0,
            createdAt:
              serverTimestamp()
          }
        );


        await audit(
          `Added contestant: ${data.name}`
        );

      }


      closeModal();

    }

    catch (error) {

      console.error(
        "Contestant save error:",
        error
      );


      alert(
        error.message ||
        "Unable to save contestant."
      );

    }

  };


/* =========================================================
   EXPORT RESULTS
========================================================= */

$("#export").onclick =
  () => {

    const ranked =
      contestants
        .slice()
        .sort(
          (a, b) =>
            Number(b.votes || 0) -
            Number(a.votes || 0)
        );


    const rows = [
      [
        "Rank",
        "Name",
        "Category",
        "Votes"
      ],

      ...ranked.map(
        (contestant, index) => [
          index + 1,
          contestant.name,
          contestant.category,
          contestant.votes || 0
        ]
      )
    ];


    const csv =
      rows
        .map(
          row =>
            row
              .map(
                value =>
                  `"${String(
                    value ?? ""
                  ).replaceAll(
                    '"',
                    '""'
                  )}"`
              )
              .join(",")
        )
        .join("\n");


    const link =
      document.createElement("a");


    link.href =
      URL.createObjectURL(
        new Blob(
          [csv],
          {
            type:
              "text/csv;charset=utf-8"
          }
        )
      );


    link.download =
      "napas-results.csv";


    link.click();


    URL.revokeObjectURL(
      link.href
    );

  };

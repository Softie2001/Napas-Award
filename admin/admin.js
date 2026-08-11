import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
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
  orderBy,
  getDoc
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

const appFirebase =
  initializeApp(FIREBASE_CONFIG);

const auth =
  getAuth(appFirebase);

const db =
  getFirestore(appFirebase);

/*
 * Keep Firebase authentication persistent on this device.
 */
const authPersistenceReady =
  setPersistence(
    auth,
    browserLocalPersistence
  ).catch(error => {
    console.error(
      "Firebase auth persistence error:",
      error
    );
  });

/* =========================================================
   DEFAULT CATEGORIES
========================================================= */

let CATEGORIES = [
  "Best Graduating Student",
  "Most Outstanding Student",
  "Best Dressed (Male)",
  "Best Dressed (Female)",
  "Most Fashionable (SWD)",
  "Player of the Year",
  "Best Class Governor",
  "Most Influential Student",
  "Content Creator of the Year",
  "Most Popular Student",
  "Ambassador of the Year",
  "Techie of the Year",
  "Entrepreneur of the Year",
  "Best Clerk of the Year",
  "Best Assistant Governor of the Year",
  "Miss Ebony",
  "Most Outspoken",
  "Coach of the Year",
  "Face of Accountancy",
  "Mrs Accountancy",
  "Blogger of the Year",
  "Brand of the Year"
];

/* =========================================================
   STATE
========================================================= */

let contestants = [];

let settings = {
  votingOpen: true,
  votePrice: 100
};

let unsubscribeStarted = false;

let authReady = false;

/* =========================================================
   HELPERS
========================================================= */

const $ = selector =>
  document.querySelector(selector);

const $$ = selector =>
  [...document.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]
  );
}

/* =========================================================
   ADMIN EMAIL HELPER
========================================================= */

function getAdminEmail() {
  return String(
    ADMIN_EMAIL || ""
  )
    .trim()
    .toLowerCase();
}

function isAuthorisedAdmin(user) {
  if (!user || !user.email) {
    return false;
  }

  const adminEmail =
    getAdminEmail();

  /*
   * ADMIN_EMAIL must be configured.
   */
  if (!adminEmail) {
    console.error(
      "ADMIN_EMAIL is missing from js/config.js."
    );

    return false;
  }

  return (
    user.email
      .trim()
      .toLowerCase() ===
    adminEmail
  );
}

/* =========================================================
   FIREBASE CATEGORY SYSTEM
========================================================= */

async function loadCategories() {
  try {
    const categoryRef = doc(
      db,
      "settings",
      "categories"
    );
    const snapshot = await getDoc(categoryRef);
    /*
     * These are the categories that must always exist.
     * Firebase categories will be preserved and these
     * will be added if they are missing.
     */
    const requiredCategories = [
      "Best Graduating Student",
      "Most Outstanding Student",
      "Best Dressed (Male)",
      "Best Dressed (Female)",
      "Most Fashionable (SWD)",
      "Player of the Year",
      "Best Class Governor",
      "Most Influential Student",
      "Content Creator of the Year",
      "Most Popular Student",
      "Ambassador of the Year",
      "Techie of the Year",
      "Entrepreneur of the Year",
      "Best Clerk of the Year",
      "Best Assistant Governor of the Year",
      "Miss Ebony",
      "Most Outspoken",
      "Coach of the Year",
      "Face of Accountancy",
      "Mrs Accountancy",
      "Blogger of the Year",
      "Brand of the Year"
    ];
    let existingCategories = [];
    if (snapshot.exists()) {
      const data = snapshot.data();
      if (Array.isArray(data.categories)) {
        existingCategories = data.categories
          .map(category =>
            String(category).trim()
          )
          .filter(Boolean);
      }
    }
    /*
     * Start with everything already saved in Firebase.
     * This prevents existing categories from disappearing.
     */
    const mergedCategories = [
      ...existingCategories
    ];
    /*
     * Add any required category that doesn't already exist.
     */
    requiredCategories.forEach(category => {
      const exists = mergedCategories.some(
        existing =>
          existing.toLowerCase() ===
          category.toLowerCase()
      );
      if (!exists) {
        mergedCategories.push(category);
      }
    });
    /*
     * Remove accidental duplicates while preserving order.
     */
    const uniqueCategories = [];
    mergedCategories.forEach(category => {
      const exists = uniqueCategories.some(
        existing =>
          existing.toLowerCase() ===
          category.toLowerCase()
      );
      if (!exists) {
        uniqueCategories.push(category);
      }
    });
    CATEGORIES = uniqueCategories;
    /*
     * Keep Firebase synchronized with the final list.
     */
    await setDoc(
      categoryRef,
      {
        categories: CATEGORIES,
        updatedAt: serverTimestamp()
      },
      {
        merge: true
      }
    );
    console.log(
      "NAPAS categories loaded:",
      CATEGORIES
    );
  } catch (error) {
    console.error(
      "Category loading error:",
      error
    );
    /*
     * If Firebase temporarily fails, still keep the
     * built-in category list available.
     */
    CATEGORIES = [
      "Best Graduating Student",
      "Most Outstanding Student",
      "Best Dressed (Male)",
      "Best Dressed (Female)",
      "Most Fashionable (SWD)",
      "Player of the Year",
      "Best Class Governor",
      "Most Influential Student",
      "Content Creator of the Year",
      "Most Popular Student",
      "Ambassador of the Year",
      "Techie of the Year",
      "Entrepreneur of the Year",
      "Best Clerk of the Year",
      "Best Assistant Governor of the Year",
      "Miss Ebony",
      "Most Outspoken",
      "Coach of the Year",
      "Face of Accountancy",
      "Mrs Accountancy",
      "Blogger of the Year",
      "Brand of the Year"
    ];
  }
}

/* =========================================================
   SAVE CATEGORIES
========================================================= */

async function saveCategories() {
  try {
    await setDoc(
      doc(
        db,
        "settings",
        "categories"
      ),
      {
        categories:
          CATEGORIES,

        updatedAt:
          serverTimestamp()
      },
      {
        merge: true
      }
    );

    await audit(
      "NAPAS voting categories updated."
    );

    return true;

  } catch (error) {
    console.error(
      "Category save error:",
      error
    );

    return false;
  }
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
    $(
      `.nav-item[data-page="${page}"]`
    );

  if (
    activeButton &&
    $("#title")
  ) {
    $("#title").textContent =
      activeButton.textContent.trim();
  }

  if ($("#sidebar")) {
    $("#sidebar").classList.remove(
      "open"
    );
  }
}

/* =========================================================
   LOGIN
========================================================= */

const loginForm =
  $("#loginForm");

if (loginForm) {
  loginForm.addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const email =
        $("#email").value.trim();

      const password =
        $("#password").value;

      if ($("#error")) {
        $("#error").textContent =
          "";
      }

      if (
        !email ||
        !password
      ) {
        if ($("#error")) {
          $("#error").textContent =
            "Please enter your email and password.";
        }

        return;
      }

      const submitButton =
        loginForm.querySelector(
          'button[type="submit"]'
        );

      if (submitButton) {
        submitButton.disabled =
          true;

        submitButton.textContent =
          "Signing in...";
      }

      try {
        /*
         * Make absolutely sure Firebase persistence
         * has been configured before signing in.
         */
        await authPersistenceReady;

        const credential =
          await signInWithEmailAndPassword(
            auth,
            email,
            password
          );

        const user =
          credential.user;

        /*
         * Check administrator account.
         */
        if (
          !isAuthorisedAdmin(user)
        ) {
          await signOut(auth);

          throw new Error(
            "This account is not authorised for the NAPAS admin portal."
          );
        }

        /*
         * Login succeeded.
         *
         * Do NOT manually reload the page.
         * onAuthStateChanged will open the dashboard.
         */

        if ($("#error")) {
          $("#error").textContent =
            "";
        }

      } catch (error) {
        console.error(
          "Admin login error:",
          error
        );

        const code =
          error?.code || "";

        let message =
          "Unable to sign in.";

        if (
          code ===
          "auth/invalid-credential"
        ) {
          message =
            "Incorrect email or password.";
        } else if (
          code ===
          "auth/user-not-found"
        ) {
          message =
            "No administrator account exists with this email.";
        } else if (
          code ===
          "auth/wrong-password"
        ) {
          message =
            "Incorrect password.";
        } else if (
          code ===
          "auth/invalid-email"
        ) {
          message =
            "Please enter a valid email address.";
        } else if (
          code ===
          "auth/too-many-requests"
        ) {
          message =
            "Too many login attempts. Please wait a little and try again.";
        } else if (
          code ===
          "auth/network-request-failed"
        ) {
          message =
            "Network error. Please check your internet connection.";
        } else if (
          error?.message
        ) {
          message =
            error.message;
        }

        if ($("#error")) {
          $("#error").textContent =
            message;
        }

      } finally {
        if (submitButton) {
          submitButton.disabled =
            false;

          submitButton.textContent =
            "Sign in securely";
        }
      }
    }
  );
}

/* =========================================================
   AUTH STATE
========================================================= */

onAuthStateChanged(
  auth,
  user => {

    authReady = true;

    const allowed =
      isAuthorisedAdmin(user);

    /*
     * IMPORTANT:
     * Only change the UI after Firebase has finished
     * checking the authentication state.
     */

    if (!authReady) {
      return;
    }

    if ($("#login")) {
      $("#login").classList.toggle(
        "hidden",
        allowed
      );
    }

    if ($("#app")) {
      $("#app").classList.toggle(
        "hidden",
        !allowed
      );
    }

    if (allowed) {

      if ($("#who")) {
        $("#who").textContent =
          user.email;
      }

      if (!unsubscribeStarted) {
        startAdminPortal();
      }

    } else {

      if ($("#who")) {
        $("#who").textContent =
          "";
      }
    }
  }
);

/* =========================================================
   LOGOUT
========================================================= */

if ($("#logout")) {
  $("#logout").addEventListener(
    "click",
    async () => {

      try {
        await signOut(auth);

        /*
         * Firebase auth listener will return the
         * interface to the login screen.
         */

      } catch (error) {
        console.error(
          "Logout error:",
          error
        );
      }
    }
  );
}

/* =========================================================
   MOBILE MENU
========================================================= */

if ($("#menu")) {
  $("#menu").addEventListener(
    "click",
    () => {

      if ($("#sidebar")) {
        $("#sidebar").classList.toggle(
          "open"
        );
      }
    }
  );
}

/* =========================================================
   NAVIGATION BUTTONS
========================================================= */

$$(".nav-item").forEach(button => {
  button.addEventListener(
    "click",
    () => {
      showPage(
        button.dataset.page
      );
    }
  );
});

$$("[data-page-jump]").forEach(button => {
  button.addEventListener(
    "click",
    () => {
      showPage(
        button.dataset.pageJump
      );
    }
  );
});

/* =========================================================
   START ADMIN PORTAL
========================================================= */

async function startAdminPortal() {

  unsubscribeStarted =
    true;

  /*
   * Load categories before rendering
   * category controls.
   */

  await loadCategories();

  /* =======================================================
     CATEGORY DROPDOWN
  ======================================================= */

  if ($("#cat")) {
    $("#cat").innerHTML =
      CATEGORIES
        .map(
          category =>
            `<option value="${esc(category)}">${esc(category)}</option>`
        )
        .join("");
  }

  if ($("#filter")) {
    $("#filter").innerHTML =
      `<option value="">All categories</option>` +
      CATEGORIES
        .map(
          category =>
            `<option value="${esc(category)}">${esc(category)}</option>`
        )
        .join("");
  }

  renderCategories();

  /* =======================================================
     CONTESTANTS LISTENER
  ======================================================= */

  onSnapshot(
    collection(
      db,
      "contestants"
    ),
    snapshot => {

      contestants =
        snapshot.docs.map(
          documentSnapshot => ({
            id:
              documentSnapshot.id,

            ...documentSnapshot.data()
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
     VOTING SETTINGS LISTENER
  ======================================================= */

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

      if ($("#vp")) {
        $("#vp").value =
          settings.votePrice ||
          100;
      }

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
     ACTIVITY LISTENER
  ======================================================= */

  onSnapshot(
    query(
      collection(
        db,
        "adminActivity"
      ),
      orderBy(
        "createdAt",
        "desc"
      )
    ),

    snapshot => {

      if (!$("#logs")) {
        return;
      }

      $("#logs").innerHTML =
        snapshot.docs
          .slice(0, 20)
          .map(
            documentSnapshot => {

              const activity =
                documentSnapshot.data();

              return `
                <p>
                  <strong>
                    ${esc(
                      activity.message ||
                      "Administrative activity"
                    )}
                  </strong>
                  <br>
                  <small>
                    ${
                      activity.createdAt?.toDate
                        ? activity.createdAt
                            .toDate()
                            .toLocaleString()
                        : "Recent activity"
                    }
                  </small>
                </p>
              `;
            }
          )
          .join("") ||
        `<p>No recent activity.</p>`;
    },

    error => {

      console.warn(
        "Activity log unavailable:",
        error
      );

      if ($("#logs")) {
        $("#logs").innerHTML =
          "<p>Activity is not available yet.</p>";
      }
    }
  );
}

/* =========================================================
   CATEGORIES DISPLAY
========================================================= */

function renderCategories() {

  if (!$("#cats")) {
    return;
  }

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
                ${String(
                  index + 1
                ).padStart(2, "0")}
              </span>

              <h3>
                ${esc(category)}
              </h3>

              <p>
                ${count}
                contestant${
                  count === 1
                    ? ""
                    : "s"
                }
                registered
              </p>

            </article>
          `;
        }
      )
      .join("");
}

/* =========================================================
   GENERATE UNIQUE CONTESTANT ID
========================================================= */

function generateUniqueContestantId() {

  const existingIds =
    new Set(
      contestants.map(
        contestant =>
          String(
            contestant.id || ""
          )
            .trim()
            .toUpperCase()
      )
    );

  let number = 1;

  while (true) {

    const candidate =
      `CNT-${String(
        number
      ).padStart(4, "0")}`;

    if (
      !existingIds.has(
        candidate
      )
    ) {
      return candidate;
    }

    number++;
  }
}

/* =========================================================
   CONTESTANTS
========================================================= */

function render() {

  if (!$("#rows")) {
    return;
  }

  const search =
    ($("#search")?.value || "")
      .toLowerCase()
      .trim();

  const category =
    $("#filter")?.value ||
    "";

  const state =
    $("#state")?.value ||
    "";

  const filtered =
    contestants.filter(
      contestant => {

        const text =
          `
          ${contestant.name || ""}
          ${contestant.id || ""}
          `
            .toLowerCase();

        const published =
          contestant.published !==
          false;

        return (
          (!search ||
            text.includes(
              search
            )) &&

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
        contestant => `

          <tr>

            <td>
              <strong>
                ${esc(
                  contestant.name ||
                  "Unnamed contestant"
                )}
              </strong>
            </td>

            <td>
              ${esc(
                contestant.category ||
                ""
              )}
            </td>

            <td>
              ${esc(
                contestant.id
              )}
            </td>

            <td>

              <span
                class="pill ${
                  contestant.published !== false
                    ? "published"
                    : "unpublished"
                }"
              >

                ${
                  contestant.published !== false
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
                  data-edit="${esc(
                    contestant.id
                  )}"
                >
                  Edit
                </button>

                <button
                  data-pub="${esc(
                    contestant.id
                  )}"
                >

                  ${
                    contestant.published !== false
                      ? "Unpublish"
                      : "Publish"
                  }

                </button>

                <button
                  data-del="${esc(
                    contestant.id
                  )}"
                >
                  Delete
                </button>

              </div>

            </td>

          </tr>
        `
      )
      .join("") ||

    `
      <tr>
        <td colspan="6">
          No contestants match your search.
        </td>
      </tr>
    `;

  /* =======================================================
     EDIT
  ======================================================= */

  $$("[data-edit]").forEach(
    button => {

      button.addEventListener(
        "click",
        () => {

          const contestant =
            contestants.find(
              item =>
                item.id ===
                button.dataset.edit
            );

          if (contestant) {
            openEdit(
              contestant
            );
          }
        }
      );
    }
  );

  /* =======================================================
     PUBLISH
  ======================================================= */

  $$("[data-pub]").forEach(
    button => {

      button.addEventListener(
        "click",
        async () => {

          const contestant =
            contestants.find(
              item =>
                item.id ===
                button.dataset.pub
            );

          if (!contestant) {
            return;
          }

          const newPublished =
            contestant.published ===
            false;

          await updateDoc(
            doc(
              db,
              "contestants",
              contestant.id
            ),
            {
              published:
                newPublished,

              updatedAt:
                serverTimestamp()
            }
          );

          await audit(
            `${
              newPublished
                ? "Published"
                : "Unpublished"
            } contestant: ${
              contestant.name
            }`
          );
        }
      );
    }
  );

  /* =======================================================
     DELETE
  ======================================================= */

  $$("[data-del]").forEach(
    button => {

      button.addEventListener(
        "click",
        async () => {

          const contestant =
            contestants.find(
              item =>
                item.id ===
                button.dataset.del
            );

          if (!contestant) {
            return;
          }

          const confirmed =
            confirm(
              `Delete ${contestant.name}? This removes the contestant record.`
            );

          if (!confirmed) {
            return;
          }

          await deleteDoc(
            doc(
              db,
              "contestants",
              contestant.id
            )
          );

          await audit(
            `Deleted contestant: ${
              contestant.name
            }`
          );
        }
      );
    }
  );

  /* =======================================================
     DASHBOARD STATISTICS
  ======================================================= */

  const totalVotes =
    contestants.reduce(
      (sum, contestant) =>
        sum +
        Number(
          contestant.votes || 0
        ),
      0
    );

  if ($("#sc")) {
    $("#sc").textContent =
      contestants.length
        .toLocaleString();
  }

  if ($("#sv")) {
    $("#sv").textContent =
      totalVotes.toLocaleString();
  }

  if ($("#sr")) {

    const revenue =
      totalVotes *
      Number(
        settings.votePrice ||
        100
      );

    $("#sr").textContent =
      `₦${revenue.toLocaleString()}`;
  }

  if ($("#ss")) {
    $("#ss").textContent =
      settings.votingOpen
        ? "OPEN"
        : "CLOSED";
  }

  if ($("#statusHint")) {
    $("#statusHint").textContent =
      settings.votingOpen
        ? "Voters can vote"
        : "Voting is currently closed";
  }

  if ($("#headerStatus")) {
    $("#headerStatus").textContent =
      settings.votingOpen
        ? "Voting open"
        : "Voting closed";
  }

  /* =======================================================
     RESULTS
  ======================================================= */

  const ranked =
    [...contestants].sort(
      (a, b) =>
        Number(
          b.votes || 0
        ) -
        Number(
          a.votes || 0
        )
    );

  if ($("#result")) {

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
                ${esc(
                  contestant.name ||
                  "Unnamed"
                )}
              </td>

              <td>
                ${esc(
                  contestant.category ||
                  ""
                )}
              </td>

              <td>
                <strong>
                  ${Number(
                    contestant.votes ||
                    0
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
  }

  /* =======================================================
     TOP CONTESTANTS
  ======================================================= */

  if ($("#topContestants")) {

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
                  ${esc(
                    contestant.name ||
                    "Unnamed"
                  )}
                </strong>

                <small>
                  ${esc(
                    contestant.category ||
                    ""
                  )}
                </small>

              </div>

              <strong>
                ${Number(
                  contestant.votes ||
                  0
                ).toLocaleString()}
              </strong>

            </div>
          `
        )
        .join("") ||

      "No contestants yet.";
  }

  renderCategories();
}

/* =========================================================
   VOTING STATUS
========================================================= */

function renderVotingState() {

  if (!$("#votingStateCard")) {
    return;
  }

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

  if ($("#toggle")) {
    $("#toggle").textContent =
      open
        ? "Close voting"
        : "Open voting";
  }
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

  } catch (error) {

    console.warn(
      "Audit log failed:",
      error
    );
  }
}

/* =========================================================
   EDIT / ADD CONTESTANT
========================================================= */

function openEdit(
  contestant = null
) {

  if (!$("#modal")) {
    return;
  }

  $("#modal").classList.remove(
    "hidden"
  );

  $("#mt").textContent =
    contestant
      ? "Edit contestant"
      : "Add contestant";

  $("#eid").value =
    contestant?.id ||
    "";

  $("#name").value =
    contestant?.name ||
    "";

  /*
   * IMPORTANT:
   * Existing contestant keeps the existing ID.
   *
   * New contestant gets a genuinely unused ID.
   */

  $("#cid").value =
    contestant?.id ||
    generateUniqueContestantId();

  $("#cat").value =
    contestant?.category ||
    CATEGORIES[0];

  $("#nick").value =
    contestant?.nickname ||
    "";

  $("#bio").value =
    contestant?.bio ||
    "";

  $("#pub").checked =
    contestant
      ? contestant.published !==
        false
      : true;

  $("#preview").innerHTML =
    contestant?.photo
      ? `
        <img
          src="${esc(
            contestant.photo
          )}"
          alt="Current photo"
        >
      `
      : "";

  $("#photo").value =
    "";
}

/* =========================================================
   CLOSE MODAL
========================================================= */

function closeModal() {

  if ($("#modal")) {
    $("#modal").classList.add(
      "hidden"
    );
  }
}

if ($("#add")) {

  $("#add").addEventListener(
    "click",
    () => openEdit()
  );
}

if ($("#x")) {

  $("#x").addEventListener(
    "click",
    closeModal
  );
}

if ($("#cancel")) {

  $("#cancel").addEventListener(
    "click",
    closeModal
  );
}

if ($("#modal")) {

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
}

/* =========================================================
   SEARCH / FILTERS
========================================================= */

if ($("#search")) {

  $("#search").addEventListener(
    "input",
    render
  );
}

if ($("#filter")) {

  $("#filter").addEventListener(
    "change",
    render
  );
}

if ($("#state")) {

  $("#state").addEventListener(
    "change",
    render
  );
}

/* =========================================================
   VOTING TOGGLE
========================================================= */

if ($("#toggle")) {

  $("#toggle").addEventListener(
    "click",
    async () => {

      const newState =
        !settings.votingOpen;

      await setDoc(
        doc(
          db,
          "settings",
          "voting"
        ),
        {
          votingOpen:
            newState,

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
          newState
            ? "opened"
            : "closed"
        }`
      );
    }
  );
}

/* =========================================================
   SAVE VOTE PRICE
========================================================= */

if ($("#save")) {

  $("#save").addEventListener(
    "click",
    async () => {

      const price =
        Math.max(
          1,
          Number(
            $("#vp").value
          ) ||
          100
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
    }
  );
}

/* =========================================================
   SAVE CONTESTANT
========================================================= */

if ($("#form")) {

  $("#form").addEventListener(
    "submit",
    async event => {

      event.preventDefault();

      try {

        /* =================================================
           FIND EXISTING CONTESTANT
        ================================================= */

        const editingId =
          $("#eid").value.trim();

        const oldContestant =
          contestants.find(
            contestant =>
              contestant.id ===
              editingId
          );

        /* =================================================
           CONTESTANT ID
        ================================================= */

        let id =
          $("#cid").value.trim();

        /*
         * NEW CONTESTANT
         */

        if (!oldContestant) {

          /*
           * If no ID was supplied, generate one.
           */

          if (!id) {
            id =
              generateUniqueContestantId();
          }

          /*
           * Prevent overwriting an existing contestant.
           */

          const duplicate =
            contestants.find(
              contestant =>
                contestant.id ===
                id
            );

          if (duplicate) {

            throw new Error(
              `Contestant ID ${id} already belongs to ${duplicate.name}. Please use another ID.`
            );
          }
        }

        /*
         * EDITING EXISTING CONTESTANT
         *
         * Always keep the original Firebase ID.
         */

        if (oldContestant) {
          id =
            oldContestant.id;
        }

        if (!id) {
          throw new Error(
            "Contestant ID is required."
          );
        }

        /* =================================================
           NAME
        ================================================= */

        const name =
          $("#name").value.trim();

        if (!name) {
          throw new Error(
            "Contestant name is required."
          );
        }

        /* =================================================
           CATEGORY
        ================================================= */

        const category =
          $("#cat").value;

        if (!category) {
          throw new Error(
            "Please select a category."
          );
        }

        /* =================================================
           PHOTO
        ================================================= */

        let photoUrl =
          oldContestant?.photo ||
          "";

        const file =
          $("#photo").files[0];

        /* =================================================
           CLOUDINARY PHOTO UPLOAD
        ================================================= */

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
                method:
                  "POST",

                body:
                  formData
              }
            );

          if (!response.ok) {
            throw new Error(
              "Image upload failed."
            );
          }

          const uploaded =
            await response.json();

          if (
            !uploaded.secure_url
          ) {
            throw new Error(
              "Cloudinary did not return a valid image URL."
            );
          }

          photoUrl =
            uploaded.secure_url;
        }

        /* =================================================
           DATA
        ================================================= */

        const data = {

          name,

          category,

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

        /* =================================================
           UPDATE EXISTING
        ================================================= */

        if (oldContestant) {

          await updateDoc(
            doc(
              db,
              "contestants",
              oldContestant.id
            ),
            data
          );

          await audit(
            `Updated contestant: ${data.name}`
          );
        }

        /* =================================================
           ADD NEW
        ================================================= */

        else {

          /*
           * setDoc uses the unique ID.
           *
           * We already checked that it does not exist.
           */

          await setDoc(
            doc(
              db,
              "contestants",
              id
            ),
            {
              ...data,

              id,

              votes:
                0,

              createdAt:
                serverTimestamp()
            }
          );

          await audit(
            `Added contestant: ${data.name} (${id})`
          );
        }

        closeModal();

      } catch (error) {

        console.error(
          "Save contestant error:",
          error
        );

        alert(
          error?.message ||
          "Unable to save contestant."
        );
      }
    }
  );
}

/* =========================================================
   EXPORT RESULTS
========================================================= */

if ($("#export")) {

  $("#export").addEventListener(
    "click",
    () => {

      const ranked =
        [...contestants].sort(
          (a, b) =>
            Number(
              b.votes || 0
            ) -
            Number(
              a.votes || 0
            )
        );

      const rows = [

        [
          "Rank",
          "Name",
          "Category",
          "Votes"
        ],

        ...ranked.map(
          (
            contestant,
            index
          ) => [

            index + 1,

            contestant.name,

            contestant.category,

            contestant.votes ||
              0
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
                      value
                    ).replaceAll(
                      '"',
                      '""'
                    )}"`
                )
                .join(",")
          )
          .join("\n");

      const blob =
        new Blob(
          [csv],
          {
            type:
              "text/csv;charset=utf-8;"
          }
        );

      const url =
        URL.createObjectURL(
          blob
        );

      const link =
        document.createElement(
          "a"
        );

      link.href =
        url;

      link.download =
        "napas-results.csv";

      link.click();

      URL.revokeObjectURL(
        url
      );
    }
  );
}

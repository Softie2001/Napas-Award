import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {
  FIREBASE_CONFIG,
  EVENT_TIME
} from "./config.js";
/* =========================================================
   FIREBASE
========================================================= */
const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);
/* =========================================================
   PAYMENT WORKER
========================================================= */
const WORKER_URL =
  "https://crimson-wave-afc5.quadrisubomi.workers.dev";
/* =========================================================
   CATEGORIES
   MUST MATCH ADMIN PAGE
========================================================= */
const FALLBACK_CATEGORIES = [
  "Best Graduating Student",
  "Most Outstanding Student",
  "Best Dressed (Male)",
  "Best Dressed (Female)",
  "Most Fashionable",
  "Best Class Governor",
  "Miss Accountancy",
  "Mrs Accountancy",
  "Player of the Year",
  "Ambassador of the Year",
  "Best Graphics Designer of the Year",
  "Best Course Rep of the Year",
  "Entrepreneur of the Year",
  "Best Clerk of the Year",
  "Best Assistant Governor of the Year",
  "Miss Ebony",
  "Most Outspoken",
  "Coach of the Year",
  "Content Creator of the Year",
  "Blogger of the Year",
  "Brand of the Year"
];
/* =========================================================
   VOTE OPTIONS
========================================================= */
const VOTE_OPTIONS = [
  1,
  5,
  10,
  20,
  50,
  100
];
/* =========================================================
   STATE
========================================================= */
let contestants = [];
let settings = {
  votingOpen: true,
  votePrice: 100
};
let selectedContestant = null;
let selectedVotes = null;
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
    }[character])
  );
}
function naira(value) {
  return (
    "₦" +
    Number(value || 0).toLocaleString("en-NG")
  );
}
function setText(selector, value) {
  const element = $(selector);
  if (element) {
    element.textContent = value;
  }
}
/* =========================================================
   COUNTDOWN
========================================================= */
function updateCountdown() {
  const target =
    new Date(EVENT_TIME).getTime();
  const left = Math.max(
    0,
    Math.floor(
      (target - Date.now()) / 1000
    )
  );
  const days =
    Math.floor(left / 86400);
  const hours =
    Math.floor(
      (left % 86400) / 3600
    );
  const minutes =
    Math.floor(
      (left % 3600) / 60
    );
  const seconds =
    left % 60;
  setText(
    "#days",
    String(days).padStart(2, "0")
  );
  setText(
    "#hours",
    String(hours).padStart(2, "0")
  );
  setText(
    "#minutes",
    String(minutes).padStart(2, "0")
  );
  setText(
    "#seconds",
    String(seconds).padStart(2, "0")
  );
}
updateCountdown();
setInterval(
  updateCountdown,
  1000
);
/* =========================================================
   CONTESTANT HELPERS
========================================================= */
function categoryName(contestant) {
  return String(
    contestant?.category ||
    contestant?.awardCategory ||
    contestant?.eventCategory ||
    "Award Category"
  );
}
function contestantImage(contestant) {
  return (
    contestant?.photo ||
    contestant?.image ||
    contestant?.photoUrl ||
    contestant?.imageUrl ||
    ""
  );
}
function contestantMeta(contestant) {
  return [
    contestant?.department ||
      contestant?.course,
    contestant?.level ||
      contestant?.className,
    contestant?.matricNumber ||
      contestant?.matric
  ].filter(Boolean);
}
/* =========================================================
   FILTERING
========================================================= */
function filtered() {
  const searchInput =
    $("#search");
  const categoryInput =
    $("#category");
  const query =
    searchInput?.value
      ?.trim()
      .toLowerCase() || "";
  const category =
    categoryInput?.value || "";
  return contestants.filter(
    contestant => {
      const text = [
        contestant?.name,
        contestant?.nickname,
        categoryName(contestant),
        ...contestantMeta(contestant)
      ]
        .join(" ")
        .toLowerCase();
      const matchesSearch =
        !query ||
        text.includes(query);
      const matchesCategory =
        !category ||
        categoryName(contestant) ===
          category;
      return (
        matchesSearch &&
        matchesCategory
      );
    }
  );
}
/* =========================================================
   CATEGORIES
========================================================= */
function renderCategories() {
  /*
    IMPORTANT FIX:
    Always start with the official category list.
    Then add any category that already exists
    in Firestore but is not yet in the list.
    This prevents the voter page from losing
    categories simply because contestants exist.
  */
  const firestoreCategories =
    contestants
      .map(categoryName)
      .filter(
        category =>
          category &&
          category !== "Award Category"
      );
  const categories = [
    ...FALLBACK_CATEGORIES
  ];
  firestoreCategories.forEach(
    category => {
      if (
        !categories.includes(category)
      ) {
        categories.push(category);
      }
    }
  );
  /* -------------------------------------------------------
     CATEGORY SELECT
  ------------------------------------------------------- */
  const categorySelect =
    $("#category");
  if (categorySelect) {
    const currentValue =
      categorySelect.value;
    categorySelect.innerHTML =
      `<option value="">
        All categories
      </option>` +
      categories
        .map(
          category =>
            `<option value="${esc(
              category
            )}">
              ${esc(category)}
            </option>`
        )
        .join("");
    /*
      Keep the currently selected category
      after the list refreshes.
    */
    if (
      currentValue &&
      categories.includes(
        currentValue
      )
    ) {
      categorySelect.value =
        currentValue;
    }
  }
  /* -------------------------------------------------------
     CATEGORY PILLS
  ------------------------------------------------------- */
  const pills =
    $("#pills");
  if (pills) {
    const currentCategory =
      $("#category")?.value || "";
    pills.innerHTML =
      `<button
        type="button"
        class="${
          currentCategory === ""
            ? "active"
            : ""
        }"
        data-cat=""
      >
        All
      </button>` +
      categories
        .map(
          category =>
            `<button
              type="button"
              class="${
                currentCategory ===
                category
                  ? "active"
                  : ""
              }"
              data-cat="${esc(
                category
              )}"
            >
              ${esc(category)}
            </button>`
        )
        .join("");
    $$("#pills button").forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            const category =
              button.dataset.cat || "";
            if ($("#category")) {
              $("#category").value =
                category;
            }
            $$("#pills button").forEach(
              item =>
                item.classList.remove(
                  "active"
                )
            );
            button.classList.add(
              "active"
            );
            renderContestants();
          }
        );
      }
    );
  }
  /* -------------------------------------------------------
     CATEGORY GRID
  ------------------------------------------------------- */
  const categoryGrid =
    $("#categoryGrid");
  if (categoryGrid) {
    categoryGrid.innerHTML =
      categories
        .map(category => {
          const count =
            contestants.filter(
              contestant =>
                categoryName(
                  contestant
                ) === category
            ).length;
          return `
            <a
              class="category-card"
              href="#voting"
              data-category-link="${esc(
                category
              )}"
            >
              <span>
                <span>
                  <strong>
                    ${esc(category)}
                  </strong>
                  <small>
                    ${count}
                    nominee${
                      count === 1
                        ? ""
                        : "s"
                    }
                  </small>
                </span>
              </span>
              <span class="category-arrow">
                ›
              </span>
            </a>
          `;
        })
        .join("");
    $$(
      "[data-category-link]"
    ).forEach(link => {
      link.addEventListener(
        "click",
        () => {
          const category =
            link.dataset
              .categoryLink || "";
          if ($("#category")) {
            $("#category").value =
              category;
          }
          $$("#pills button").forEach(
            button => {
              button.classList.toggle(
                "active",
                (button.dataset.cat ||
                  "") === category
              );
            }
          );
          setTimeout(
            renderContestants,
            0
          );
        }
      );
    });
  }
}
/* =========================================================
   CONTESTANTS
========================================================= */
function renderContestants() {
  const grid =
    $("#grid");
  if (!grid) {
    return;
  }
  const list =
    filtered();
  const empty =
    $("#empty");
  if (empty) {
    empty.classList.toggle(
      "hidden",
      list.length > 0
    );
  }
  grid.innerHTML =
    list
      .map(contestant => {
        const image =
          contestantImage(
            contestant
          );
        const meta =
          contestantMeta(
            contestant
          );
        const votes =
          Number(
            contestant?.votes || 0
          ).toLocaleString();
        return `
          <article class="card">
            <div class="card-photo">
              ${
                image
                  ? `
                    <img
                      src="${esc(image)}"
                      alt="${esc(
                        contestant?.name ||
                          "Contestant"
                      )}"
                      loading="lazy"
                    >
                  `
                  : `
                    <div
                      class="card-photo-placeholder"
                      aria-hidden="true"
                    ></div>
                  `
              }
            </div>
            <div class="card-body">
              <span class="card-cat">
                ${esc(
                  categoryName(
                    contestant
                  )
                )}
              </span>
              <h3 class="card-name">
                ${esc(
                  contestant?.name ||
                    "Unnamed contestant"
                )}
              </h3>
              ${
                contestant?.nickname
                  ? `
                    <div class="card-sub">
                      ${esc(
                        contestant.nickname
                      )}
                    </div>
                  `
                  : ""
              }
              ${
                meta.length
                  ? `
                    <div class="card-info">
                      ${meta
                        .map(
                          value =>
                            `<span>${esc(
                              value
                            )}</span>`
                        )
                        .join("")}
                    </div>
                  `
                  : ""
              }
              <div class="card-votes">
                ${votes} votes
              </div>
              <button
                class="btn btn-purple contestant-vote"
                type="button"
                data-id="${esc(
                  contestant.id
                )}"
                ${
                  settings.votingOpen
                    ? ""
                    : "disabled"
                }
              >
                ${
                  settings.votingOpen
                    ? "Vote Now"
                    : "Voting Closed"
                }
                <span>→</span>
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  $$(".contestant-vote").forEach(
    button => {
      button.addEventListener(
        "click",
        () =>
          openModal(
            button.dataset.id
          )
      );
    }
  );
  renderLeaderboard();
}
/* =========================================================
   LEADERBOARD
========================================================= */
function renderLeaderboard() {
  const leaderboard =
    $("#leaderboard");
  if (!leaderboard) {
    return;
  }
  const top =
    [...contestants]
      .sort(
        (a, b) =>
          Number(b?.votes || 0) -
          Number(a?.votes || 0)
      )
      .slice(0, 10);
  if (!top.length) {
    leaderboard.innerHTML = `
      <div class="empty-state">
        No results available yet.
      </div>
    `;
    return;
  }
  leaderboard.innerHTML =
    top
      .map(
        (contestant, index) => `
          <div class="leader-row">
            <span
              class="rank ${
                index < 3
                  ? "top"
                  : ""
              }"
            >
              ${index + 1}
            </span>
            <div class="leaderboard-person">
              <strong>
                ${esc(
                  contestant?.name ||
                    "Unnamed contestant"
                )}
              </strong>
              <small>
                ${esc(
                  categoryName(
                    contestant
                  )
                )}
              </small>
            </div>
            <strong class="leaderboard-votes">
              ${Number(
                contestant?.votes || 0
              ).toLocaleString()}
            </strong>
          </div>
        `
      )
      .join("");
}
/* =========================================================
   STATUS
========================================================= */
function setStatus() {
  const open =
    !!settings.votingOpen;
  setText(
    "#status",
    open
      ? "Voting Open"
      : "Voting Closed"
  );
  const status =
    $("#status");
  if (status) {
    status.style.color =
      open
        ? "var(--success)"
        : "var(--danger)";
  }
  setText(
    "#heroStatus",
    open
      ? "OPEN NOW"
      : "CLOSED"
  );
  setText(
    "#price",
    naira(
      settings.votePrice
    )
  );
}
/* =========================================================
   ANONYMOUS VOTER
========================================================= */
function createAnonymousVoter() {
  const timestamp =
    Date.now();
  const random =
    Math.random()
      .toString(36)
      .slice(2, 10);
  return {
    name:
      "NAPAS Voter",
    email:
      `voter-${timestamp}-${random}@napas-award.com`,
    phone:
      ""
  };
}
/* =========================================================
   VOTING MODAL
========================================================= */
function openModal(id) {
  selectedContestant =
    contestants.find(
      contestant =>
        contestant.id === id
    );
  if (!selectedContestant) {
    return;
  }
  selectedVotes =
    null;
  setText(
    "#modalCategory",
    categoryName(
      selectedContestant
    )
  );
  setText(
    "#modalName",
    selectedContestant.name ||
      "Contestant"
  );
  setText(
    "#modalMeta",
    [
      ...contestantMeta(
        selectedContestant
      ),
      `${Number(
        selectedContestant.votes ||
          0
      ).toLocaleString()} votes`
    ]
      .filter(Boolean)
      .join(" • ")
  );
  const image =
    contestantImage(
      selectedContestant
    );
  const modalPhoto =
    $("#modalPhoto");
  if (modalPhoto) {
    modalPhoto.innerHTML =
      image
        ? `
          <img
            src="${esc(image)}"
            alt="${esc(
              selectedContestant.name ||
                "Contestant"
            )}"
          >
        `
        : `
          <div
            class="card-photo-placeholder"
            aria-hidden="true"
          ></div>
        `;
  }
  setText(
    "#modalPrice",
    naira(
      settings.votePrice
    )
  );
  const customVotes =
    $("#customVotes");
  if (customVotes) {
    customVotes.value = "";
  }
  const paymentError =
    $("#paymentError");
  if (paymentError) {
    paymentError.classList.add(
      "hidden"
    );
    paymentError.textContent = "";
  }
  /*
    Old voter details are no longer required.
  */
  [
    "#voterName",
    "#voterEmail",
    "#voterPhone"
  ].forEach(selector => {
    const input =
      $(selector);
    if (input) {
      input.value = "";
      const label =
        input.closest("label");
      if (label) {
        label.style.display =
          "none";
      }
    }
  });
  /* -------------------------------------------------------
     VOTE OPTIONS
  ------------------------------------------------------- */
  const voteOptions =
    $("#voteOptions");
  if (voteOptions) {
    voteOptions.innerHTML =
      VOTE_OPTIONS
        .map(
          votes => `
            <button
              type="button"
              class="vote-option"
              data-votes="${votes}"
            >
              ${votes.toLocaleString()}
              <span>
                ${naira(
                  votes *
                    Number(
                      settings.votePrice
                    )
                )}
              </span>
            </button>
          `
        )
        .join("");
    $$(".vote-option").forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            selectedVotes =
              Number(
                button.dataset.votes
              );
            if (customVotes) {
              customVotes.value =
                "";
            }
            $$(".vote-option").forEach(
              item =>
                item.classList.remove(
                  "selected"
                )
            );
            button.classList.add(
              "selected"
            );
            updateTotal();
          }
        );
      }
    );
  }
  updateTotal();
  const modal =
    $("#voteModal");
  if (modal) {
    modal.classList.remove(
      "hidden"
    );
    modal.setAttribute(
      "aria-hidden",
      "false"
    );
    document.body.classList.add(
      "modal-open"
    );
  }
}
/* =========================================================
   UPDATE TOTAL
========================================================= */
function updateTotal() {
  const custom =
    Number(
      $("#customVotes")?.value ||
        0
    );
  if (custom > 0) {
    selectedVotes =
      Math.floor(custom);
    $$(".vote-option").forEach(
      option =>
        option.classList.remove(
          "selected"
        )
    );
  }
  const amount =
    selectedVotes
      ? selectedVotes *
        Number(
          settings.votePrice
        )
      : 0;
  setText(
    "#modalTotal",
    naira(amount)
  );
  const pay =
    $("#pay");
  if (pay) {
    pay.disabled = !(
      settings.votingOpen &&
      selectedContestant &&
      selectedVotes > 0
    );
  }
}
/* =========================================================
   CLOSE VOTING MODAL
========================================================= */
function closeModal() {
  const modal =
    $("#voteModal");
  if (modal) {
    modal.classList.add(
      "hidden"
    );
    modal.setAttribute(
      "aria-hidden",
      "true"
    );
  }
  document.body.classList.remove(
    "modal-open"
  );
  selectedContestant =
    null;
  selectedVotes =
    null;
}
/* =========================================================
   MODAL EVENTS
========================================================= */
const modalClose =
  $("#modalClose");
if (modalClose) {
  modalClose.addEventListener(
    "click",
    closeModal
  );
}
const voteModal =
  $("#voteModal");
if (voteModal) {
  voteModal.addEventListener(
    "click",
    event => {
      if (
        event.target ===
        event.currentTarget
      ) {
        closeModal();
      }
    }
  );
}
const customVotesInput =
  $("#customVotes");
if (customVotesInput) {
  customVotesInput.addEventListener(
    "input",
    updateTotal
  );
}
/* =========================================================
   START PAYMENT
========================================================= */
async function startPayment() {
  const error =
    $("#paymentError");
  if (error) {
    error.classList.add(
      "hidden"
    );
    error.textContent = "";
  }
  if (
    !selectedContestant ||
    !selectedVotes ||
    selectedVotes < 1
  ) {
    return;
  }
  const button =
    $("#pay");
  if (!button) {
    return;
  }
  button.disabled =
    true;
  button.textContent =
    "Preparing secure payment...";
  const voter =
    createAnonymousVoter();
  try {
    const response =
      await fetch(
        `${WORKER_URL}/initialize`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            contestantId:
              selectedContestant.id,
            votes:
              selectedVotes,
            email:
              voter.email,
            name:
              voter.name,
            phone:
              voter.phone,
            callbackUrl:
              `${location.origin}${location.pathname}?payment=return`
          })
        }
      );
    const data =
      await response.json();
    if (
      !response.ok ||
      !data.success
    ) {
      throw new Error(
        data.error ||
          "Unable to start payment."
      );
    }
    sessionStorage.setItem(
      "napas_pending_payment",
      JSON.stringify({
        reference:
          data.reference,
        contestantId:
          selectedContestant.id,
        votes:
          selectedVotes,
        email:
          voter.email,
        name:
          voter.name,
        phone:
          voter.phone
      })
    );
    location.href =
      data.authorization_url;
  } catch (errorObject) {
    console.error(
      "Payment initialization error:",
      errorObject
    );
    if (error) {
      error.textContent =
        errorObject.message ||
        "Unable to start payment. Please try again.";
      error.classList.remove(
        "hidden"
      );
    }
    button.disabled =
      false;
    button.textContent =
      "Make Payment";
  }
}
/* =========================================================
   PAYMENT BUTTON
========================================================= */
const payButton =
  $("#pay");
if (payButton) {
  payButton.addEventListener(
    "click",
    startPayment
  );
}
/* =========================================================
   PAYMENT RETURN / VERIFICATION
========================================================= */
async function handlePaymentReturn() {
  const params =
    new URLSearchParams(
      location.search
    );
  const reference =
    params.get("reference") ||
    params.get("trxref");
  if (!reference) {
    return;
  }
  const pendingRaw =
    sessionStorage.getItem(
      "napas_pending_payment"
    );
  if (!pendingRaw) {
    return;
  }
  let pending;
  try {
    pending =
      JSON.parse(
        pendingRaw
      );
  } catch {
    sessionStorage.removeItem(
      "napas_pending_payment"
    );
    return;
  }
  /*
    Remove payment parameters from
    the visible browser URL.
  */
  history.replaceState(
    {},
    document.title,
    location.pathname +
      location.hash
  );
  try {
    const response =
      await fetch(
        `${WORKER_URL}/verify`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            reference,
            contestantId:
              pending.contestantId,
            votes:
              pending.votes,
            email:
              pending.email,
            name:
              pending.name,
            phone:
              pending.phone
          })
        }
      );
    const data =
      await response.json();
    if (
      !response.ok ||
      !data.success
    ) {
      throw new Error(
        data.error ||
          "Payment verification failed."
      );
    }
    sessionStorage.removeItem(
      "napas_pending_payment"
    );
    if ($("#successText")) {
      $("#successText").textContent =
        `${Number(
          pending.votes
        ).toLocaleString()} vote${
          Number(
            pending.votes
          ) === 1
            ? ""
            : "s"
        } have been added to the selected contestant.`;
    }
    if ($("#successVotes")) {
      $("#successVotes").textContent =
        Number(
          data.newTotalVotes ||
            0
        ).toLocaleString();
    }
    if ($("#successReference")) {
      $("#successReference").textContent =
        reference;
    }
    const successModal =
      $("#successModal");
    if (successModal) {
      successModal.classList.remove(
        "hidden"
      );
      successModal.setAttribute(
        "aria-hidden",
        "false"
      );
    }
  } catch (errorObject) {
    console.error(
      "Payment verification error:",
      errorObject
    );
    sessionStorage.removeItem(
      "napas_pending_payment"
    );
    alert(
      errorObject.message ||
        "Payment verification failed. If money was deducted, keep your Paystack reference and contact NAPAS."
    );
  }
}
/* =========================================================
   SUCCESS MODAL
========================================================= */
function closeSuccessModal() {
  const modal =
    $("#successModal");
  if (modal) {
    modal.classList.add(
      "hidden"
    );
    modal.setAttribute(
      "aria-hidden",
      "true"
    );
  }
}
const successClose =
  $("#successClose");
if (successClose) {
  successClose.addEventListener(
    "click",
    closeSuccessModal
  );
}
const successResults =
  $("#successResults");
if (successResults) {
  successResults.addEventListener(
    "click",
    closeSuccessModal
  );
}
/* =========================================================
   SEARCH
========================================================= */
const search =
  $("#search");
if (search) {
  search.addEventListener(
    "input",
    renderContestants
  );
}
/* =========================================================
   CATEGORY SELECT
========================================================= */
const category =
  $("#category");
if (category) {
  category.addEventListener(
    "change",
    () => {
      const selected =
        category.value;
      $$("#pills button").forEach(
        button => {
          button.classList.toggle(
            "active",
            (button.dataset.cat ||
              "") === selected
          );
        }
      );
      renderContestants();
    }
  );
}
/* =========================================================
   MOBILE MENU
========================================================= */
function closeMobileMenu() {
  const mobileMenu =
    $("#mobileMenu");
  if (mobileMenu) {
    mobileMenu.style.display =
      "none";
  }
  const menuButton =
    $("#menuBtn");
  if (menuButton) {
    menuButton.setAttribute(
      "aria-expanded",
      "false"
    );
  }
}
const menuButton =
  $("#menuBtn");
if (menuButton) {
  menuButton.addEventListener(
    "click",
    () => {
      const mobileMenu =
        $("#mobileMenu");
      if (!mobileMenu) {
        return;
      }
      const isOpen =
        mobileMenu.style.display ===
        "block";
      mobileMenu.style.display =
        isOpen
          ? "none"
          : "block";
      menuButton.setAttribute(
        "aria-expanded",
        String(!isOpen)
      );
    }
  );
}
$$(
  "#mobileMenu a"
).forEach(link => {
  link.addEventListener(
    "click",
    closeMobileMenu
  );
});
/* =========================================================
   ESCAPE KEY
========================================================= */
document.addEventListener(
  "keydown",
  event => {
    if (
      event.key !==
      "Escape"
    ) {
      return;
    }
    const voteModal =
      $("#voteModal");
    if (
      voteModal &&
      !voteModal.classList.contains(
        "hidden"
      )
    ) {
      closeModal();
    }
    const successModal =
      $("#successModal");
    if (
      successModal &&
      !successModal.classList.contains(
        "hidden"
      )
    ) {
      closeSuccessModal();
    }
    closeMobileMenu();
  }
);
/* =========================================================
   FIREBASE SETTINGS
========================================================= */
async function loadSettings() {
  try {
    const snapshot =
      await getDoc(
        doc(
          db,
          "settings",
          "voting"
        )
      );
    if (snapshot.exists()) {
      settings = {
        ...settings,
        ...snapshot.data()
      };
    }
  } catch (error) {
    console.warn(
      "Voting settings unavailable; using safe defaults.",
      error
    );
  }
  setStatus();
  renderCategories();
  renderContestants();
}
/* =========================================================
   FIREBASE CONTESTANTS
========================================================= */
onSnapshot(
  collection(
    db,
    "contestants"
  ),
  snapshot => {
    contestants =
      snapshot.docs
        .map(
          documentSnapshot => ({
            id:
              documentSnapshot.id,
            ...documentSnapshot.data()
          })
        )
        .filter(
          contestant =>
            contestant.published !==
            false
        );
    console.log(
      "NAPAS contestants loaded:",
      contestants
    );
    /*
      Rebuild the category interface
      every time contestant data changes.
    */
    renderCategories();
    renderContestants();
  },
  error => {
    console.error(
      "Contestants listener error:",
      error
    );
    const empty =
      $("#empty");
    if (empty) {
      empty.classList.remove(
        "hidden"
      );
      empty.innerHTML = `
        <div class="empty-state">
          Unable to load contestants.
          Please refresh the page.
        </div>
      `;
    }
  }
);
/* =========================================================
   START APPLICATION
========================================================= */
loadSettings();
handlePaymentReturn();

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
   NAPAS DOMAIN
========================================================= */

const SITE_URL =
  "https://napasawardvote.name.ng";

/* =========================================================
   PAYMENT WORKER
========================================================= */

const WORKER_URL =
  "https://crimson-wave-afc5.quadrisubomi.workers.dev";

/* =========================================================
   FALLBACK CATEGORIES
========================================================= */

const FALLBACK_CATEGORIES = [
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

let contestantsLoaded = false;
let settingsLoaded = false;

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
    Number(value || 0).toLocaleString(
      "en-NG"
    )
  );
}


function setText(selector, value) {
  const element = $(selector);

  if (element) {
    element.textContent = value;
  }
}


/* =========================================================
   PAYMENT ERROR HELPER
========================================================= */

function showPaymentError(message) {
  const error =
    $("#paymentError");

  if (!error) {
    alert(message);
    return;
  }

  error.textContent =
    message ||
    "Unable to start payment. Please try again.";

  error.classList.remove(
    "hidden"
  );
}


function clearPaymentError() {
  const error =
    $("#paymentError");

  if (!error) {
    return;
  }

  error.textContent = "";

  error.classList.add(
    "hidden"
  );
}


/* =========================================================
   SAFE JSON RESPONSE
=========================================================

   This prevents the browser from showing a vague
   "Load failed" when the Worker returns HTML,
   an empty response, or another invalid response.
========================================================= */

async function readWorkerResponse(
  response
) {
  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  const text =
    await response.text();

  if (!text) {
    throw new Error(
      `Payment server returned an empty response (${response.status}).`
    );
  }

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        "Payment server returned invalid JSON."
      );
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Payment server returned an unexpected response (${response.status}).`
    );
  }
}


/* =========================================================
   COUNTDOWN
========================================================= */

function updateCountdown() {
  const target =
    new Date(EVENT_TIME).getTime();

  if (
    !Number.isFinite(target)
  ) {
    return;
  }

  const left = Math.max(
    0,
    Math.floor(
      (target - Date.now()) /
        1000
    )
  );

  const days =
    Math.floor(
      left / 86400
    );

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
    String(days).padStart(
      2,
      "0"
    )
  );

  setText(
    "#hours",
    String(hours).padStart(
      2,
      "0"
    )
  );

  setText(
    "#minutes",
    String(minutes).padStart(
      2,
      "0"
    )
  );

  setText(
    "#seconds",
    String(seconds).padStart(
      2,
      "0"
    )
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

function categoryName(
  contestant
) {
  return String(
    contestant?.category ||
    contestant?.awardCategory ||
    contestant?.eventCategory ||
    "Award Category"
  );
}


function contestantImage(
  contestant
) {
  return (
    contestant?.photo ||
    contestant?.image ||
    contestant?.photoUrl ||
    contestant?.imageUrl ||
    ""
  );
}


function contestantMeta(
  contestant
) {
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
   DIRECT CONTESTANT LINK
=========================================================

   Example:

   https://napasawardvote.name.ng/?contestant=CNT-0001

   The contestant ID is the Firestore document ID.
========================================================= */

function getDirectContestantId() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  return (
    params.get(
      "contestant"
    ) ||
    params.get(
      "contestantId"
    ) ||
    ""
  ).trim();
}


function buildContestantLink(
  contestant
) {
  if (!contestant?.id) {
    return SITE_URL;
  }

  return (
    `${SITE_URL}/?contestant=` +
    encodeURIComponent(
      contestant.id
    )
  );
}


/* =========================================================
   COPY CONTESTANT LINK
========================================================= */

async function copyContestantLink(
  contestant
) {
  const link =
    buildContestantLink(
      contestant
    );

  try {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(
        link
      );
    } else {
      const textarea =
        document.createElement(
          "textarea"
        );

      textarea.value = link;

      textarea.style.position =
        "fixed";

      textarea.style.opacity =
        "0";

      document.body.appendChild(
        textarea
      );

      textarea.select();

      document.execCommand(
        "copy"
      );

      textarea.remove();
    }

    alert(
      "Contestant voting link copied."
    );

  } catch (error) {
    console.error(
      "Copy link error:",
      error
    );

    alert(
      `Copy this voting link:\n\n${link}`
    );
  }
}


/* =========================================================
   SHARE CONTESTANT
========================================================= */

async function shareContestant(
  contestant
) {
  const link =
    buildContestantLink(
      contestant
    );

  const name =
    contestant?.name ||
    "this NAPAS contestant";

  const category =
    categoryName(
      contestant
    );

  const shareText =
    `Vote for ${name} in ${category} at the NAPAS Dinner & Award Night 2026.\n\n${link}`;

  try {
    if (
      navigator.share
    ) {
      await navigator.share({
        title:
          `Vote for ${name} — NAPAS Award Night 2026`,
        text:
          shareText,
        url:
          link
      });

      return;
    }

    await copyContestantLink(
      contestant
    );

  } catch (error) {
    /*
      User cancelling native share
      is not an application error.
    */

    if (
      error?.name ===
      "AbortError"
    ) {
      return;
    }

    console.error(
      "Share error:",
      error
    );

    await copyContestantLink(
      contestant
    );
  }
}


/* =========================================================
   SHOW DIRECT CONTESTANT
========================================================= */

function openDirectContestant() {
  const id =
    getDirectContestantId();

  if (!id) {
    return;
  }

  if (!contestantsLoaded) {
    return;
  }

  const contestant =
    contestants.find(
      item =>
        String(item.id) ===
        String(id)
    );

  if (!contestant) {
    console.warn(
      "Direct contestant not found:",
      id
    );

    const grid =
      $("#grid");

    if (grid) {
      grid.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }

    return;
  }

  /*
    Make sure the user lands on the
    voting section.
  */

  const voting =
    $("#voting");

  if (voting) {
    voting.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

  /*
    Open the contestant's voting
    profile automatically.
  */

  setTimeout(
    () => {
      openModal(
        contestant.id
      );
    },
    450
  );
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
      .toLowerCase() ||
    "";

  const category =
    categoryInput?.value ||
    "";

  return contestants.filter(
    contestant => {
      const text = [
        contestant?.name,
        contestant?.nickname,
        categoryName(
          contestant
        ),
        ...contestantMeta(
          contestant
        )
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch =
        !query ||
        text.includes(query);

      const matchesCategory =
        !category ||
        categoryName(
          contestant
        ) === category;

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
  const categories = [
    ...new Set(
      contestants
        .map(
          categoryName
        )
        .filter(Boolean)
    )
  ];

  const list =
    categories.length
      ? categories
      : FALLBACK_CATEGORIES;


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
      list
        .map(
          category =>
            `<option value="${esc(
              category
            )}">
              ${esc(category)}
            </option>`
        )
        .join("");

    if (
      list.includes(
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
    const current =
      $("#category")?.value ||
      "";

    pills.innerHTML =
      `<button
        type="button"
        class="${
          current === ""
            ? "active"
            : ""
        }"
        data-cat=""
      >
        All
      </button>` +

      list
        .map(
          category =>
            `<button
              type="button"
              class="${
                current ===
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
              button.dataset.cat ||
              "";

            if (
              $("#category")
            ) {
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
      list
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
              .categoryLink ||
            "";

          if (
            $("#category")
          ) {
            $("#category").value =
              category;
          }

          $$("#pills button").forEach(
            button => {
              button.classList.toggle(
                "active",
                (button.dataset.cat ||
                  "") ===
                  category
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
      .map(
        contestant => {
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
              contestant?.votes ||
                0
            ).toLocaleString();

          return `
            <article
              class="card"
              data-contestant-card="${esc(
                contestant.id
              )}"
            >

              <div class="card-photo">
                ${
                  image
                    ? `
                      <img
                        src="${esc(
                          image
                        )}"
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

                <div class="contestant-actions">

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

                  <button
                    class="contestant-share"
                    type="button"
                    data-share-id="${esc(
                      contestant.id
                    )}"
                    aria-label="Share contestant voting link"
                    title="Share voting link"
                  >
                    ↗
                  </button>

                </div>

              </div>

            </article>
          `;
        }
      )
      .join("");


  /* -------------------------------------------------------
     VOTE BUTTONS
  ------------------------------------------------------- */

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


  /* -------------------------------------------------------
     SHARE BUTTONS
  ------------------------------------------------------- */

  $$(
    "[data-share-id]"
  ).forEach(button => {
    button.addEventListener(
      "click",
      async event => {
        event.preventDefault();
        event.stopPropagation();

        const contestant =
          contestants.find(
            item =>
              String(item.id) ===
              String(
                button.dataset
                  .shareId
              )
          );

        if (!contestant) {
          return;
        }

        await shareContestant(
          contestant
        );
      }
    );
  });


  /* -------------------------------------------------------
     CLICK CONTESTANT PROFILE
  -------------------------------------------------------

     Clicking the main profile/card opens
     the contestant voting profile.

  ------------------------------------------------------- */

  $$(
    "[data-contestant-card]"
  ).forEach(card => {
    card.addEventListener(
      "click",
      event => {
        /*
          Do not trigger when the user clicked
          a button inside the card.
        */

        if (
          event.target.closest(
            "button"
          )
        ) {
          return;
        }

        const id =
          card.dataset
            .contestantCard;

        openModal(id);
      }
    );
  });


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
          Number(
            b?.votes || 0
          ) -
          Number(
            a?.votes || 0
          )
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
                contestant?.votes ||
                  0
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
        String(
          contestant.id
        ) ===
        String(id)
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


  /* -------------------------------------------------------
     MODAL IMAGE
  ------------------------------------------------------- */

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


  /* -------------------------------------------------------
     MODAL PRICE
  ------------------------------------------------------- */

  setText(
    "#modalPrice",
    naira(
      settings.votePrice
    )
  );


  /* -------------------------------------------------------
     RESET FIELDS
  ------------------------------------------------------- */

  const customVotes =
    $("#customVotes");

  if (customVotes) {
    customVotes.value =
      "";
  }


  clearPaymentError();


  /* -------------------------------------------------------
     HIDE OLD VOTER DETAILS
  ------------------------------------------------------- */

  [
    "#voterName",
    "#voterEmail",
    "#voterPhone"
  ].forEach(
    selector => {
      const input =
        $(selector);

      if (!input) {
        return;
      }

      input.value =
        "";

      const label =
        input.closest(
          "label"
        );

      if (label) {
        label.style.display =
          "none";
      }
    }
  );


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
                button.dataset
                  .votes
              );

            if (
              customVotes
            ) {
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


  /* -------------------------------------------------------
     MODAL
  ------------------------------------------------------- */

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
      $("#customVotes")
        ?.value ||
        0
    );

  if (
    custom > 0
  ) {
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


const customVotes =
  $("#customVotes");

if (customVotes) {
  customVotes.addEventListener(
    "input",
    updateTotal
  );
}


/* =========================================================
   START PAYMENT
========================================================= */

async function startPayment() {
  clearPaymentError();

  if (
    !selectedContestant
  ) {
    showPaymentError(
      "Please select a contestant first."
    );

    return;
  }

  if (
    !selectedVotes ||
    selectedVotes < 1
  ) {
    showPaymentError(
      "Please select at least one vote."
    );

    return;
  }

  if (
    !settings.votingOpen
  ) {
    showPaymentError(
      "Voting is currently closed."
    );

    return;
  }


  const button =
    $("#pay");

  if (!button) {
    return;
  }


  const contestantId =
    String(
      selectedContestant.id ||
        ""
    ).trim();

  if (!contestantId) {
    showPaymentError(
      "This contestant does not have a valid voting ID."
    );

    return;
  }


  const votes =
    Math.floor(
      Number(
        selectedVotes
      )
    );

  if (
    !Number.isFinite(votes) ||
    votes < 1
  ) {
    showPaymentError(
      "Please enter a valid number of votes."
    );

    return;
  }


  button.disabled =
    true;

  button.textContent =
    "Preparing secure payment...";


  const voter =
    createAnonymousVoter();


  /*
    IMPORTANT:

    Always return to the actual website,
    not the Cloudflare Worker.
  */

  const callbackUrl =
    `${SITE_URL}/?payment=return`;


  const payload = {
    contestantId,

    votes,

    email:
      voter.email,

    name:
      voter.name,

    phone:
      voter.phone,

    callbackUrl
  };


  console.log(
    "NAPAS payment initialization:",
    {
      contestantId,
      votes,
      callbackUrl
    }
  );


  try {

    /*
      Abort the request after 25 seconds
      instead of leaving the user staring
      at a loading screen forever.
    */

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        25000
      );


    let response;

    try {

      response =
        await fetch(
          `${WORKER_URL}/initialize`,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "Accept":
                "application/json"
            },

            body:
              JSON.stringify(
                payload
              ),

            signal:
              controller.signal,

            cache:
              "no-store"
          }
        );

    } finally {

      clearTimeout(
        timeout
      );
    }


    const data =
      await readWorkerResponse(
        response
      );


    console.log(
      "NAPAS payment Worker response:",
      data
    );


    if (
      !response.ok
    ) {
      throw new Error(
        data?.error ||
          data?.message ||
          `Payment server error (${response.status}).`
      );
    }


    if (
      !data?.success
    ) {
      throw new Error(
        data?.error ||
          data?.message ||
          "Payment could not be initialized."
      );
    }


    if (
      !data.authorization_url
    ) {
      throw new Error(
        "Payment server did not return a Paystack checkout URL."
      );
    }


    /*
      Save payment information before
      leaving the website.
    */

    sessionStorage.setItem(
      "napas_pending_payment",
      JSON.stringify({
        reference:
          data.reference ||
          "",

        contestantId,

        votes,

        email:
          voter.email,

        name:
          voter.name,

        phone:
          voter.phone
      })
    );


    /*
      Send voter directly to Paystack.
    */

    window.location.assign(
      data.authorization_url
    );

  } catch (errorObject) {

    console.error(
      "NAPAS payment initialization error:",
      errorObject
    );


    let message =
      "Unable to connect to the payment server.";


    if (
      errorObject?.name ===
      "AbortError"
    ) {

      message =
        "The payment server took too long to respond. Please try again.";

    } else if (
      errorObject?.message
    ) {

      message =
        errorObject.message;
    }


    showPaymentError(
      message
    );


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
      window.location.search
    );


  const reference =
    params.get(
      "reference"
    ) ||
    params.get(
      "trxref"
    );


  if (!reference) {
    return;
  }


  const pendingRaw =
    sessionStorage.getItem(
      "napas_pending_payment"
    );


  if (!pendingRaw) {

    console.warn(
      "Payment reference exists but no pending payment was found:",
      reference
    );

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
    Remove Paystack query parameters
    from the address bar.
  */

  const cleanUrl =
    `${SITE_URL}/`;


  try {

    history.replaceState(
      {},
      document.title,
      cleanUrl
    );

  } catch {
    /*
      Not fatal.
    */
  }


  try {

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        30000
      );


    let response;

    try {

      response =
        await fetch(
          `${WORKER_URL}/verify`,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "Accept":
                "application/json"
            },

            body:
              JSON.stringify({
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
              }),

            signal:
              controller.signal,

            cache:
              "no-store"
          }
        );

    } finally {

      clearTimeout(
        timeout
      );
    }


    const data =
      await readWorkerResponse(
        response
      );


    console.log(
      "NAPAS payment verification response:",
      data
    );


    if (
      !response.ok
    ) {
      throw new Error(
        data?.error ||
          data?.message ||
          `Payment verification server error (${response.status}).`
      );
    }


    if (
      !data?.success
    ) {
      throw new Error(
        data?.error ||
          data?.message ||
          "Payment verification failed."
      );
    }


    /*
      Payment is verified.

      Only now remove the pending payment.
    */

    sessionStorage.removeItem(
      "napas_pending_payment"
    );


    const verifiedVotes =
      Number(
        pending.votes ||
          data.votes ||
          0
      );


    if (
      $("#successText")
    ) {
      $("#successText")
        .textContent =
        `${verifiedVotes.toLocaleString()} vote${
          verifiedVotes === 1
            ? ""
            : "s"
        } have been added to the selected contestant.`;
    }


    if (
      $("#successVotes")
    ) {
      $("#successVotes")
        .textContent =
        Number(
          data.newTotalVotes ||
            data.totalVotes ||
            0
        ).toLocaleString();
    }


    if (
      $("#successReference")
    ) {
      $("#successReference")
        .textContent =
        reference;
    }


    /*
      Refresh contestant data before
      showing success, so the public
      page receives the latest vote count.
    */

    const successModal =
      $("#successModal");


    if (
      successModal
    ) {

      successModal.classList.remove(
        "hidden"
      );

      successModal.setAttribute(
        "aria-hidden",
        "false"
      );
    }


  } catch (
    errorObject
  ) {

    console.error(
      "NAPAS payment verification error:",
      errorObject
    );


    /*
      IMPORTANT:

      Do NOT delete the pending payment
      when verification fails.

      Keeping it allows another verification
      attempt after a temporary network error.
    */

    let message =
      "We could not verify the payment right now.";


    if (
      errorObject?.name ===
      "AbortError"
    ) {

      message =
        "Payment verification took too long. Please wait a moment and refresh the page.";

    } else if (
      errorObject?.message
    ) {

      message =
        errorObject.message;
    }


    alert(
      `${message}\n\nPayment reference: ${reference}\n\nIf money was deducted, do not pay again immediately. Keep this reference.`
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
              "") ===
              selected
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
).forEach(
  link => {
    link.addEventListener(
      "click",
      closeMobileMenu
    );
  }
);


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


    if (
      snapshot.exists()
    ) {

      settings = {
        ...settings,
        ...snapshot.data()
      };
    }

  } catch (
    error
  ) {

    console.warn(
      "Voting settings unavailable; using safe defaults.",
      error
    );
  }


  settingsLoaded =
    true;


  setStatus();

  renderCategories();

  renderContestants();

  openDirectContestant();
}


/* =========================================================
   FIREBASE CONTESTANTS
=========================================================

   Admin collection:

       contestants

   Public page:

       contestants

   Only:

       published !== false

   are displayed.
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


    contestantsLoaded =
      true;


    console.log(
      "NAPAS contestants loaded:",
      contestants
    );


    renderCategories();

    renderContestants();


    /*
      If somebody opened a contestant
      share link, open that contestant
      as soon as Firebase finishes loading.
    */

    openDirectContestant();
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


/* =========================================================
   GLOBAL CONTESTANT SHARE FUNCTION
=========================================================

   This makes the share functionality
   available to other UI elements if
   we add them later.
========================================================= */

window.NAPAS = {
  shareContestant,
  copyContestantLink,
  buildContestantLink
};

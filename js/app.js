import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

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

const app =
  initializeApp(FIREBASE_CONFIG);

const db =
  getFirestore(app);


/* =========================================================
   PAYMENT WORKER
========================================================= */

const WORKER_URL =
  "https://crimson-wave-afc5.quadrisubomi.workers.dev";


/* =========================================================
   SITE URL
========================================================= */

const SITE_URL =
  "https://napasawardvote.name.ng";


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
  "Face of Accountancy",
  "Mrs Accountancy",
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

const $ =
  selector =>
    document.querySelector(selector);

const $$ =
  selector =>
    [
      ...document.querySelectorAll(selector)
    ];


function esc(value) {
  return String(value ?? "")
    .replace(
      /[&<>"']/g,
      character =>
        ({
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
    Number(value || 0)
      .toLocaleString("en-NG")
  );
}


function setText(
  selector,
  value
) {
  const element =
    $(selector);

  if (element) {
    element.textContent =
      value;
  }
}


/* =========================================================
   SHARE TOAST
========================================================= */

let toastTimer = null;


function showToast(message) {
  const toast =
    $("#shareToast");

  if (!toast) {
    return;
  }

  toast.textContent =
    message;

  toast.classList.add(
    "show"
  );

  clearTimeout(
    toastTimer
  );

  toastTimer =
    setTimeout(
      () => {
        toast.classList.remove(
          "show"
        );
      },
      2400
    );
}


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

   https://napasawardvote.name.ng/?contestant=ABC123

   The ID is the Firebase contestant document ID.

========================================================= */

function contestantShareUrl(
  contestant
) {
  if (!contestant?.id) {
    return SITE_URL;
  }

  const url =
    new URL(
      SITE_URL + "/"
    );

  url.searchParams.set(
    "contestant",
    contestant.id
  );

  return url.toString();
}


/* =========================================================
   COPY / SHARE CONTESTANT
========================================================= */

async function shareContestant(
  contestant
) {
  if (!contestant?.id) {
    return;
  }

  const shareUrl =
    contestantShareUrl(
      contestant
    );

  const name =
    contestant?.name ||
    "this NAPAS contestant";

  const shareData = {
    title:
      `${name} — NAPAS Dinner & Award Night 2026`,

    text:
      `Vote for ${name} at the NAPAS Dinner & Award Night 2026.`,

    url:
      shareUrl
  };


  /* -------------------------------------------------------
     NATIVE PHONE SHARE
  ------------------------------------------------------- */

  if (
    typeof navigator.share ===
      "function"
  ) {
    try {
      await navigator.share(
        shareData
      );

      return;
    } catch (error) {

      /* User cancelled native sharing.
         Do not show an error. */

      if (
        error?.name ===
        "AbortError"
      ) {
        return;
      }

    }
  }


  /* -------------------------------------------------------
     COPY LINK
  ------------------------------------------------------- */

  try {

    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(
        shareUrl
      );

    } else {

      const temporary =
        document.createElement(
          "textarea"
        );

      temporary.value =
        shareUrl;

      temporary.style.position =
        "fixed";

      temporary.style.left =
        "-9999px";

      document.body.appendChild(
        temporary
      );

      temporary.select();

      document.execCommand(
        "copy"
      );

      temporary.remove();
    }

    showToast(
      "Contestant link copied."
    );

  } catch (error) {

    console.error(
      "Share link copy error:",
      error
    );

    /* Last fallback:
       show the URL through a prompt
       so the user can still copy it. */

    window.prompt(
      "Copy this contestant link:",
      shareUrl
    );
  }
}


/* =========================================================
   SHARE ICON
========================================================= */

function shareIcon() {
  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="5" r="3"></circle>
      <circle cx="6" cy="12" r="3"></circle>
      <circle cx="18" cy="19" r="3"></circle>
      <path d="M8.6 13.5l6.8 3.9"></path>
      <path d="M15.4 6.6L8.6 10.5"></path>
    </svg>
  `;
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
        .map(categoryName)
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

    categorySelect.innerHTML =
      `<option value="">All categories</option>` +
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
  }


  /* -------------------------------------------------------
     CATEGORY PILLS
  ------------------------------------------------------- */

  const pills =
    $("#pills");

  if (pills) {

    pills.innerHTML =
      `<button
        type="button"
        class="active"
        data-cat=""
      >
        All
      </button>` +
      list
        .map(
          category =>
            `<button
              type="button"
              data-cat="${esc(
                category
              )}"
            >
              ${esc(category)}
            </button>`
        )
        .join("");


    $$("#pills button")
      .forEach(
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

              $$("#pills button")
                .forEach(
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
        .map(
          category => {

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
          }
        )
        .join("");


    $$(
      "[data-category-link]"
    ).forEach(
      link => {

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

            $$("#pills button")
              .forEach(
                button => {

                  button.classList.toggle(
                    "active",
                    (
                      button.dataset.cat ||
                      ""
                    ) === category
                  );

                }
              );

            setTimeout(
              renderContestants,
              0
            );
          }
        );

      }
    );
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
              contestant?.votes || 0
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
                    class="share-contestant"
                    type="button"
                    data-share-id="${esc(
                      contestant.id
                    )}"
                    aria-label="Share ${esc(
                      contestant?.name ||
                      "contestant"
                    )}"
                    title="Share"
                  >
                    ${shareIcon()}
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

  $$(".contestant-vote")
    .forEach(
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

  $$(".share-contestant")
    .forEach(
      button => {

        button.addEventListener(
          "click",
          async () => {

            const contestant =
              contestants.find(
                item =>
                  item.id ===
                  button.dataset.shareId
              );

            if (!contestant) {
              return;
            }

            button.setAttribute(
              "aria-busy",
              "true"
            );

            try {

              await shareContestant(
                contestant
              );

            } finally {

              button.removeAttribute(
                "aria-busy"
              );

            }

          }
        );

      }
    );


  renderLeaderboard();
}


/* =========================================================
   OPEN DIRECT CONTESTANT
========================================================= */

function getDirectContestantId() {

  const params =
    new URLSearchParams(
      window.location.search
    );

  return (
    params.get(
      "contestant"
    ) || ""
  ).trim();
}


function removeDirectContestantParameter() {

  const url =
    new URL(
      window.location.href
    );

  url.searchParams.delete(
    "contestant"
  );

  window.history.replaceState(
    {},
    document.title,
    url.pathname +
      url.search +
      url.hash
  );
}


function openDirectContestant() {

  const id =
    getDirectContestantId();

  if (!id) {
    return;
  }

  const contestant =
    contestants.find(
      item =>
        item.id === id
    );

  if (!contestant) {

    console.warn(
      "Shared contestant not found:",
      id
    );

    return;
  }


  /* Make sure the voting area is visible. */

  const voting =
    $("#voting");

  if (voting) {

    voting.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

  }


  /* Open the contestant directly. */

  setTimeout(
    () => {

      const card =
        document.querySelector(
          `[data-contestant-card="${CSS.escape(
            id
          )}"]`
        );

      if (card) {

        card.classList.add(
          "direct-contestant"
        );

        setTimeout(
          () => {
            card.classList.remove(
              "direct-contestant"
            );
          },
          2200
        );

      }

      openModal(id);

    },
    500
  );
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
        (contestant, index) =>
          `
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

    paymentError.textContent =
      "";

  }


  /* -------------------------------------------------------
     Hide old voter fields.
  ------------------------------------------------------- */

  const voterFields =
    $("#voterFields");


  if (voterFields) {

    voterFields.style.display =
      "none";

  }


  [
    "#voterName",
    "#voterEmail",
    "#voterPhone"
  ].forEach(
    selector => {

      const input =
        $(selector);

      if (input) {

        input.value =
          "";

        input.disabled =
          true;

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
          votes =>
            `
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


    $$(".vote-option")
      .forEach(
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


              $$(".vote-option")
                .forEach(
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
      $("#customVotes")
        ?.value || 0
    );


  if (
    custom > 0
  ) {

    selectedVotes =
      Math.min(
        1000,
        Math.floor(
          custom
        )
      );


    $$(".vote-option")
      .forEach(
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

    pay.disabled =
      !(
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

  const error =
    $("#paymentError");


  if (error) {

    error.classList.add(
      "hidden"
    );

    error.textContent =
      "";

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
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

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

              /* IMPORTANT:
                 Always return to the current
                 live domain instead of the
                 old napas-award.com domain. */

              callbackUrl:
                `${SITE_URL}/?payment=return`

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


    if (
      !data.authorization_url
    ) {

      throw new Error(
        "Payment link was not returned by the payment server."
      );

    }


    location.href =
      data.authorization_url;


  } catch (
    errorObject
  ) {

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
          method:
            "POST",

          headers: {
            "Content-Type":
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


    if (
      $("#successText")
    ) {

      $("#successText")
        .textContent =
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


    if (
      $("#successVotes")
    ) {

      $("#successVotes")
        .textContent =
        Number(
          data.newTotalVotes ||
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


  } catch (
    errorObject
  ) {

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


      $$("#pills button")
        .forEach(
          button => {

            button.classList.toggle(
              "active",
              (
                button.dataset.cat ||
                ""
              ) === selected
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


    renderCategories();
    renderContestants();


    /* -----------------------------------------------------
       If somebody opened a contestant's shared link,
       automatically take them to that contestant.
    ----------------------------------------------------- */

    if (
      getDirectContestantId()
    ) {

      openDirectContestant();

    }

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
   COUNTDOWN — NAPAS AWARD NIGHT
   Voting countdown ends on 17 August 2026
========================================================= */

const COUNTDOWN_END =
  new Date("2026-08-17T23:59:59+01:00").getTime();

function updateCountdown() {

  const now =
    Date.now();

  const distance =
    COUNTDOWN_END - now;

  const days =
    Math.max(
      0,
      Math.floor(
        distance / (1000 * 60 * 60 * 24)
      )
    );

  const hours =
    Math.max(
      0,
      Math.floor(
        (distance / (1000 * 60 * 60)) % 24
      )
    );

  const minutes =
    Math.max(
      0,
      Math.floor(
        (distance / (1000 * 60)) % 60
      )
    );

  const seconds =
    Math.max(
      0,
      Math.floor(
        (distance / 1000) % 60
      )
    );

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

  if (distance <= 0) {
    clearInterval(countdownTimer);

    setText("#days", "00");
    setText("#hours", "00");
    setText("#minutes", "00");
    setText("#seconds", "00");
  }
}

const countdownTimer =
  setInterval(
    updateCountdown,
    1000
  );

updateCountdown();


/* =========================================================
   START APPLICATION
========================================================= */

loadSettings();

handlePaymentReturn();

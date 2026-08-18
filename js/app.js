import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./config.js";

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

let contestants = [];

const $ = (selector) => document.querySelector(selector);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));

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
    contestant.photo ||
    contestant.image ||
    contestant.photoUrl ||
    contestant.imageUrl ||
    ""
  );
}

/*
  FINAL RESULTS
  ----------------
  Every contestant is ranked together.
  Categories do NOT affect the order.
  Highest votes = #1.
*/

function getFinalRanking() {
  return [...contestants].sort(
    (a, b) => Number(b.votes || 0) - Number(a.votes || 0)
  );
}

function renderOverallVotes() {
  const total = contestants.reduce(
    (sum, contestant) => sum + Number(contestant.votes || 0),
    0
  );

  const element = $("#overallVotes");

  if (element) {
    element.textContent = total.toLocaleString("en-NG");
  }
}

function renderWinners() {
  const grid = $("#winnersGrid");

  if (!grid) return;

  const ranking = getFinalRanking();

  if (!ranking.length) {
    grid.innerHTML = `
      <div class="results-empty">
        <h2>No final results available</h2>
        <p>There are currently no published contestants.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = ranking.map((contestant, index) => {
    const image = contestantImage(contestant);
    const votes = Number(contestant.votes || 0);

    return `
      <article class="winner-card">

        <div class="winner-photo">
          ${
            image
              ? `
                <img
                  src="${esc(image)}"
                  alt="${esc(contestant.name || "Contestant")}"
                  loading="lazy"
                >
              `
              : `
                <div class="winner-placeholder">🏆</div>
              `
          }
        </div>

        <div class="winner-body">

          <div class="winner-number">
            #${String(index + 1).padStart(2, "0")}
          </div>

          <div class="winner-category">
            ${esc(categoryName(contestant))}
          </div>

          <h2 class="winner-name">
            ${esc(contestant.name || "Unnamed Contestant")}
          </h2>

          <div class="winner-votes">
            <strong>
              ${votes.toLocaleString("en-NG")}
            </strong>

            <span>
              FINAL VOTES
            </span>
          </div>

        </div>

      </article>
    `;
  }).join("");
}

function renderOverallLeaderboard() {
  const list = $("#overallLeaderboard");

  if (!list) return;

  const ranking = getFinalRanking();

  list.innerHTML = ranking.map((contestant, index) => `
    <div class="final-leader-row">

      <span class="final-rank">
        ${index + 1}
      </span>

      <div>
        <strong>
          ${esc(contestant.name || "Unnamed Contestant")}
        </strong>

        <small>
          ${esc(categoryName(contestant))}
        </small>
      </div>

      <strong>
        ${Number(contestant.votes || 0).toLocaleString("en-NG")}
      </strong>

    </div>
  `).join("");
}

function render() {
  renderOverallVotes();
  renderWinners();
  renderOverallLeaderboard();
}

onSnapshot(
  collection(db, "contestants"),
  (snapshot) => {

    contestants = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data()
      }))
      .filter(
        (contestant) => contestant.published !== false
      );

    render();
  },

  (error) => {

    console.error(
      "Final results error:",
      error
    );

    const grid = $("#winnersGrid");

    if (grid) {
      grid.innerHTML = `
        <div class="results-empty">
          <h2>Unable to load final results</h2>
          <p>Please refresh the page.</p>
        </div>
      `;
    }
  }
);
import './style.css';

// Phase 2 landing page. Phase 3 replaces this with the score view.
document.querySelector<HTMLElement>('#app')!.innerHTML = `
  <h1>piano-trainer</h1>
  <p class="sub">Practice your own scores with live feedback from the piano.</p>

  <a class="card" href="${import.meta.env.BASE_URL}spike.html">
    <strong>MIDI debugger</strong>
    <span>List connected inputs and watch every message arrive. Start here.</span>
  </a>

  <div class="card" aria-disabled="true">
    <strong>Practice</strong>
    <span>Coming in phase 3.</span>
  </div>
`;

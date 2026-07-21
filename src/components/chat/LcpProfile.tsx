"use client";

// refresh #2 s7: the account's profile in the Left Chat Part, opened from the account menu's "Your
// profile". This is the DESIGNED empty state (prototype `lcpProfileEmpty`): a "No profile yet" heading,
// a resume dropzone, and GitHub/LinkedIn fields. The resume-parse / profile backend is P2, so the
// dropzone is a quiet "coming soon" affordance (accepts no upload yet) and the fields are not persisted;
// the menu item + this LCP view ship now, and it will fill in place once parsing lands.
export function LcpProfile({ onClose }: { onClose: () => void }) {
  return (
    <section className="lcp" role="region" aria-label="Your profile">
      <div className="lcp-head">
        <span className="lcp-title">Your profile</span>
        <button
          className="x-btn"
          type="button"
          aria-label="Close profile"
          onClick={onClose}
        >
          &times;
        </button>
      </div>
      <div className="lcp-body">
        <div className="profile-empty">
          <div>
            <h3>No profile yet</h3>
            <p>
              Add your resume and links, and I will find the roles that fit you.
            </p>
          </div>
          <div
            className="dropzone disabled"
            title="Resume parsing is coming soon"
          >
            Drop your resume (PDF) &mdash; coming soon
          </div>
          <div className="profile-fields">
            <div className="field">
              <label htmlFor="profile-github">GitHub</label>
              <input id="profile-github" type="text" placeholder="username" />
            </div>
            <div className="field">
              <label htmlFor="profile-linkedin">LinkedIn</label>
              <input
                id="profile-linkedin"
                type="text"
                placeholder="profile URL"
              />
            </div>
          </div>
          <span className="profile-note">
            Nothing is shared with employers until you apply.
          </span>
        </div>
      </div>
    </section>
  );
}

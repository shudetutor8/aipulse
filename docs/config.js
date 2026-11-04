// Site settings. These values are public by design — never put a secret key here.
window.AIPULSE_CONFIG = {
  // The name shown in the header and browser tab.
  siteName: "AI or Hype",

  // Shown on the Terms and Privacy pages.
  contactEmail: "aiorhype.help@gmail.com",

  // Turn on only after Google sign-in is set up in Supabase.
  googleLogin: false,

  // From Supabase → Project Settings → API Keys.
  supabaseUrl: "https://fubnqpfypwsijzmdfpyb.supabase.co",        // e.g. "https://abcdefgh.supabase.co"
  supabaseKey: "sb_publishable_F6xHsrLfq2EAj9T8tl7u3w_8wvheEIJ",        // the PUBLISHABLE key (starts with sb_publishable_). Never the secret key.

  // Your GitHub repository, e.g. "shudetutor8/aipulse". Used for the admin page's "Run jobs now" link.
  githubRepo: "shudetutor8/aipulse",
};

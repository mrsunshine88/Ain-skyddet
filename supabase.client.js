const SUPABASE_URL = 'https://pyozlvgcaozpcydmxolv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5b3psdmdjYW96cGN5ZG14b2x2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MzEyMjYsImV4cCI6MjA5MTUwNzIyNn0.GzeERLcJ3n0o0UAtJ4oPMHiNTVoFdOC8bwYqvRtbZLg';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabase = supabaseClient;
console.log("Supabase Client Initierad.");

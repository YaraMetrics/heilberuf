export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const { cvText, keywords, city, umkreis } = req.body || {};

  // Step 1: Extract profile from CV using Groq
  let profile = { name: 'Bewerber/in', mainRole: 'Fachkraft', skills: [], languages: ['Deutsch'], qualifications: [], experience: [] };
  
  try {
    const profileRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Analysiere diesen Lebenslauf und antworte NUR mit JSON:
${(cvText||'').substring(0, 2000)}

Antworte NUR mit diesem JSON (keine andere Text):
{
  "name": "Vollständiger Name",
  "mainRole": "Aktuelle/letzte Position",
  "skills": ["skill1", "skill2"],
  "languages": ["Deutsch", "Englisch"],
  "qualifications": ["z.B. Pflegefachkraft", "IHK Data Analyst"],
  "experience": ["z.B. 5 Jahre Pflege", "3 Jahre BI"],
  "canWork": ["Berufe die diese Person ausüben KANN basierend auf Qualifikationen"],
  "cannotWork": ["Berufe die diese Person NICHT ausüben kann z.B. Arzt ohne Medizinstudium"]
}`
        }],
        response_format: { type: 'json_object' }
      })
    });
    const pd = await profileRes.json();
    profile = JSON.parse(pd.choices[0].message.content);
  } catch(e) {
    console.error('Profile extraction error:', e);
  }

  // Step 2: Fetch jobs from Bundesagentur
  let rawJobs = [];
  const searches = (keywords || 'Gesundheitswesen').split(' ').filter(k => k.length > 3).slice(0, 3);
  if(searches.length === 0) searches.push('Gesundheitswesen');

  for(const kw of searches) {
    try {
      let url = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=${encodeURIComponent(kw)}&size=20`;
      if(city) url += `&wo=${encodeURIComponent(city)}`;
      if(umkreis) url += `&umkreis=${umkreis}`;
      const r = await fetch(url, { headers: { 'X-API-Key': 'jobboerse-jobsuche' } });
      const d = await r.json();
      rawJobs.push(...(d.stellenangebote || []).map((j, i) => ({
        id: rawJobs.length + i + 1,
        org: j.arbeitgeber || 'Klinik',
        location: j.arbeitsort?.ort || city || 'Deutschland',
        contract: j.arbeitszeit || 'Vollzeit',
        title: j.titel || 'Stelle',
        refnr: j.refnr || '',
        url: j.refnr ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${j.refnr}` : ''
      })));
    } catch(e) {}
  }

  // Remove duplicates
  const seen = new Set();
  rawJobs = rawJobs.filter(j => { if(seen.has(j.title)) return false; seen.add(j.title); return true; });

  // Step 3: AI matching for each job
  const cannotWork = profile.cannotWork || [];
  const canWork = profile.canWork || [];
  const qualifications = profile.qualifications || [];

  let scoredJobs = [];

  // Process in batches of 5 for speed
  const batchSize = 5;
  for(let i = 0; i < Math.min(rawJobs.length, 25); i += batchSize) {
    const batch = rawJobs.slice(i, i + batchSize);
    try {
      const matchRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: `Bewerber-Profil:
- Qualifikationen: ${qualifications.join(', ')}
- Kann arbeiten als: ${canWork.join(', ')}
- Kann NICHT arbeiten als: ${cannotWork.join(', ')}
- Skills: ${(profile.skills||[]).join(', ')}

Bewerte diese Stellen (0-100% Eignung). Gib 0% wenn die Person nicht qualifiziert ist.

Stellen:
${batch.map((j,idx) => `${idx+1}. "${j.title}" bei ${j.org}`).join('\n')}

Antworte NUR mit JSON:
{
  "matches": [
    {"index": 0, "score": 85, "reasons": ["Grund1", "Grund2", "Grund3"], "tags": ["tag1", "tag2"]},
    {"index": 1, "score": 20, "reasons": ["Nicht qualifiziert: kein Medizinstudium"], "tags": []}
  ]
}`
          }],
          response_format: { type: 'json_object' }
        })
      });
      const md = await matchRes.json();
      const matchData = JSON.parse(md.choices[0].message.content);
      matchData.matches.forEach(m => {
        if(m.score >= 50) {
          const job = batch[m.index];
          if(job) scoredJobs.push({
            ...job,
            matchScore: m.score,
            reasons: m.reasons || [],
            tags: m.tags || [job.location, job.contract].filter(Boolean),
            icon: '🏥'
          });
        }
      });
    } catch(e) {
      // fallback: add with basic score
      batch.forEach((job, idx) => {
        scoredJobs.push({
          ...job,
          matchScore: 65,
          reasons: ['Stelle aus Bundesagentur', 'Prüfen Sie die Anforderungen'],
          tags: [job.location, job.contract].filter(Boolean),
          icon: '🏥'
        });
      });
    }
  }

  // Sort by score
  scoredJobs = scoredJobs.sort((a, b) => b.matchScore - a.matchScore).slice(0, 20);

  return res.status(200).json({ profile, jobs: scoredJobs });
}

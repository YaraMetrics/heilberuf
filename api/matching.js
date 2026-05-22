export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const { cvText, keywords, city, umkreis } = req.body || {};

  // Step 1: Fetch jobs
  let rawJobs = [];
  const searches = (keywords || 'Gesundheitswesen').split(' ').filter(k => k.length > 3).slice(0, 2);
  if(!searches.length) searches.push('Gesundheitswesen');

  for(const kw of searches) {
    try {
      let url = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=${encodeURIComponent(kw)}&size=10`;
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
        url: j.refnr ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${j.refnr}` : `https://www.arbeitsagentur.de/jobsuche/suche?angebotsart=1&was=${encodeURIComponent(j.titel||'')}&wo=${encodeURIComponent(j.arbeitsort?.ort||'')}` ,
        icon: '🏥'
      })));
    } catch(e) {}
  }

  // Remove duplicates
  const seen = new Set();
  rawJobs = rawJobs.filter(j => { if(seen.has(j.title)) return false; seen.add(j.title); return true; });

  // Step 2: Fetch job details for top 8 jobs
  const top8 = rawJobs.slice(0, 8);
  const jobsWithDetails = await Promise.all(top8.map(async job => {
    if(!job.refnr) return { ...job, description: '' };
    try {
      const r = await fetch(
        `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${job.refnr}`,
        { headers: { 'X-API-Key': 'jobboerse-jobsuche' } }
      );
      const d = await r.json();
      const desc = d.stellenangebot?.stellenbeschreibung || '';
      return { ...job, description: desc.substring(0, 300) };
    } catch(e) {
      return { ...job, description: '' };
    }
  }));

  // Step 3: Smart AI matching with full job details
  let profile = { name: 'Bewerber/in', mainRole: 'Fachkraft', skills: [], languages: ['Deutsch'] };
  let scoredJobs = [];

  try {
    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2500,
        messages: [{
          role: 'user',
          content: `Du bist ein präziser Karriereberater im deutschen Gesundheitswesen.

LEBENSLAUF:
${(cvText||'').substring(0, 1500)}

STELLEN MIT BESCHREIBUNG:
${jobsWithDetails.map((j,i) => `
[${i}] ${j.title} | ${j.org} | ${j.location}
Beschreibung: ${j.description || 'Nicht verfügbar'}
`).join('\n')}

BEWERTUNGSREGELN:
- 85-100%: Qualifikationen passen sehr gut
- 65-84%: Gute Übereinstimmung
- 50-64%: Interessante Stelle, könnte passen
- 0-49%: Eindeutig nicht qualifiziert (z.B. Arzt ohne Medizinstudium) → NICHT anzeigen

WICHTIG: 
- Im Zweifel lieber 60% als 0% geben
- Pflegefachkraft kann NICHT als Arzt/Chirurg/Zahnarzt arbeiten
- Zeige möglichst viele passende Stellen (Ziel: 8-15 Ergebnisse)

Antworte NUR mit JSON:
{
  "profile": {
    "name": "Name",
    "mainRole": "Hauptposition",
    "skills": ["skill1","skill2","skill3","skill4"],
    "languages": ["Deutsch"]
  },
  "scores": [
    {
      "index": 0,
      "score": 88,
      "reasons": [
        "Pflegefachkraft-Ausbildung direkt gefordert",
        "5 Jahre Erfahrung übertreffen Mindestanforderung",
        "Standort Stuttgart passt zu Ulm-Region"
      ],
      "tags": ["Pflege","Vollzeit","Stuttgart"]
    }
  ]
}`
        }],
        response_format: { type: 'json_object' }
      })
    });

    const aiData = await aiRes.json();
    const result = JSON.parse(aiData.choices[0].message.content);
    profile = result.profile || profile;

    scoredJobs = (result.scores || [])
      .filter(s => s.score >= 45)
      .map(s => {
        const job = jobsWithDetails[s.index];
        if(!job) return null;
        return {
          ...job,
          matchScore: s.score,
          reasons: s.reasons || ['Passend zu Ihrem Profil'],
          tags: s.tags || [job.location, job.contract].filter(Boolean)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchScore - a.matchScore);

  } catch(e) {
    // Fallback — real jobs without AI scoring
    scoredJobs = jobsWithDetails.map((j, i) => ({
      ...j,
      matchScore: Math.max(50, 80 - i * 5),
      reasons: ['Aktuelle Stelle auf Bundesagentur', 'Prüfen Sie die Anforderungen'],
      tags: [j.location, j.contract].filter(Boolean)
    }));
  }

  return res.status(200).json({ profile, jobs: scoredJobs });
}

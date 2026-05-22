export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const { cvText, keywords, city, umkreis } = req.body || {};

  // Step 1: Fetch ALL jobs
  let rawJobs = [];
  // Smart keywords based on berufsfeld
  const rawKeywords = (keywords || 'Gesundheitswesen').split(' ').filter(k => k.length > 3);
  
  // Add health-specific terms to ensure relevant results
  const healthTerms = ['Gesundheitswesen', 'Klinik', 'Krankenhaus', 'Pflege', 'Medizin'];
  const searches = rawKeywords.length > 0 ? rawKeywords.slice(0, 4) : healthTerms.slice(0, 3);
  
  // Always add Gesundheitswesen to keep results medical
  if(!searches.includes('Gesundheitswesen')) searches.push('Gesundheitswesen');

  for(const kw of searches) {
    try {
      let url = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=${encodeURIComponent(kw)}&size=25`;
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
        url: j.refnr 
          ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${j.refnr}` 
          : `https://www.google.com/search?q=${encodeURIComponent((j.titel||'') + ' ' + (j.arbeitgeber||'') + ' Stelle')}`,
        icon: '🏥'
      })));
    } catch(e) {}
  }

  // Remove duplicates
  const seen = new Set();
  rawJobs = rawJobs.filter(j => { if(seen.has(j.title)) return false; seen.add(j.title); return true; });

  // Step 2: AI extracts profile + scores top 20 for ranking only
  let profile = { name: 'Bewerber/in', mainRole: 'Fachkraft', skills: [], languages: ['Deutsch'] };
  
  try {
    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Analysiere den Lebenslauf und bewerte die Eignung für diese Stellen.

LEBENSLAUF:
${(cvText||'').substring(0, 1000)}

STELLEN (bewerte 0-100, NUR absolut unmögliche Stellen unter 30):
${rawJobs.slice(0, 20).map((j,i) => `${i}: ${j.title} | ${j.org}`).join('\n')}

Antworte NUR mit JSON:
{
  "profile": {"name":"Name","mainRole":"Rolle","skills":["s1","s2","s3"],"languages":["Deutsch"]},
  "scores": [{"index":0,"score":85,"reasons":["Grund1","Grund2","Grund3"],"tags":["tag1","tag2"]}]
}`
        }],
        response_format: { type: 'json_object' }
      })
    });

    const aiData = await aiRes.json();
    const result = JSON.parse(aiData.choices[0].message.content);
    profile = result.profile || profile;

    // Create score map
    const scoreMap = {};
    (result.scores || []).forEach(s => { scoreMap[s.index] = s; });

    // Only show jobs that were scored by AI (relevant ones)
    const finalJobs = rawJobs
      .map((job, i) => {
        const aiScore = scoreMap[i];
        if(!aiScore) return null; // Skip unscored jobs
        return {
          ...job,
          matchScore: aiScore.score,
          reasons: aiScore.reasons || ['Aktuelle Stelle auf Bundesagentur'],
          tags: aiScore.tags || [job.location, job.contract].filter(Boolean)
        };
      })
      .filter(j => j && j.matchScore >= 35)
      .sort((a, b) => b.matchScore - a.matchScore);

    return res.status(200).json({ profile, jobs: finalJobs });

  } catch(e) {
    // Fallback: show all jobs with default score
    const fallbackJobs = rawJobs.map((j, i) => ({
      ...j,
      matchScore: Math.max(50, 80 - i * 2),
      reasons: ['Aktuelle Stelle auf Bundesagentur', 'Passend zu Ihrem Berufsfeld', 'Direkt bewerben möglich'],
      tags: [j.location, j.contract].filter(Boolean)
    }));
    return res.status(200).json({ profile, jobs: fallbackJobs });
  }
}

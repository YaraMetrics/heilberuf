export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const { cvText, keywords, city, umkreis } = req.body || {};

  let realJobs = [];
  const searches = (keywords || 'Gesundheitswesen').split(' ').filter(k => k.length > 3).slice(0, 3);
  if(searches.length === 0) searches.push('Gesundheitswesen');

  for(const kw of searches) {
    try {
      let url = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=${encodeURIComponent(kw)}&size=25`;
      if(city) url += `&wo=${encodeURIComponent(city)}`;
      if(umkreis) url += `&umkreis=${umkreis}`;
      const r = await fetch(url, { headers: { 'X-API-Key': 'jobboerse-jobsuche' } });
      const d = await r.json();
      const jobs = (d.stellenangebote || []).map((j, i) => ({
        id: realJobs.length + i + 1,
        org: j.arbeitgeber || 'Klinik',
        location: j.arbeitsort?.ort || city || 'Deutschland',
        contract: j.arbeitszeit || 'Vollzeit',
        title: j.titel || 'Stelle im Gesundheitswesen',
        tags: [kw, j.arbeitsort?.ort || 'Deutschland'].filter(Boolean),
        matchScore: Math.max(50, 95 - (realJobs.length + i) * 3),
        reasons: ['Aktuelle Stelle auf Bundesagentur', 'Passend zu Ihrem Profil', 'Direkt bewerben möglich'],
        icon: '🏥',
        salary: '',
        url: j.refnr ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${j.refnr}` : ''
      }));
      realJobs = [...realJobs, ...jobs];
    } catch(e) {}
  }

  // Remove duplicates by title
  const seen = new Set();
  realJobs = realJobs.filter(j => {
    if(seen.has(j.title)) return false;
    seen.add(j.title);
    return true;
  });

  // Sort by matchScore, show all above 50%
  realJobs = realJobs
    .filter(j => j.matchScore >= 50)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 30);

  // AI profile
  let profile = { name: 'Bewerber/in', mainRole: 'Fachkraft Gesundheitswesen', skills: ['Gesundheitswesen'], languages: ['Deutsch'] };
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [{ role: 'user', content: `Extrahiere aus diesem Lebenslauf NUR ein JSON:\n${(cvText||'').substring(0,1500)}\nAntworte NUR mit: {"name":"Name","mainRole":"Rolle","skills":["s1","s2"],"languages":["l1"]}` }],
        response_format: { type: 'json_object' }
      })
    });
    const d = await groqRes.json();
    profile = JSON.parse(d.choices[0].message.content);
  } catch(e) {}

  return res.status(200).json({ profile, jobs: realJobs });
}

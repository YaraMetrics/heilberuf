
exports.handler = async (event) => {

  const { cvText, keywords, city, umkreis } = JSON.parse(event.body || '{}');

  let realJobs = [];

  try {

    let url = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=${encodeURIComponent(keywords || 'Gesundheitswesen')}&size=6`;

    if(city) url += `&wo=${encodeURIComponent(city)}`;

    if(umkreis) url += `&umkreis=${umkreis}`;

    const r = await fetch(url, { headers: { 'X-API-Key': 'jobboerse-jobsuche' } });

    const d = await r.json();

    realJobs = (d.stellenangebote || []).slice(0, 4).map((j, i) => ({

      id: i + 1,

      org: j.arbeitgeber || 'Klinik',

      location: j.arbeitsort?.ort || city || 'Deutschland',

      contract: 'Vollzeit',

      title: j.titel || 'Stelle im Gesundheitswesen',

      tags: [keywords || 'Gesundheitswesen', city || 'Deutschland'],

      matchScore: 90 - (i * 5),

      reasons: ['Passend zu Ihrem Profil', 'Aktuelle Stelle auf Bundesagentur', 'Direkt bewerben möglich'],

      icon: '🏥',

      salary: '',

      url: j.refnr ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${j.refnr}` : ''

    }));

  } catch(e) {}

  let profile = { name: 'Bewerber/in', mainRole: 'Fachkraft Gesundheitswesen', skills: ['Gesundheitswesen'], languages: ['Deutsch'] };

  try {

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {

      method: 'POST',

      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },

      body: JSON.stringify({

        model: 'llama-3.3-70b-versatile',

        max_tokens: 300,

        messages: [{ role: 'user', content: `Extrahiere aus diesem Lebenslauf NUR ein JSON Profil:

${(cvText||'').substring(0,1500)}

Antworte NUR mit: {"name":"Name","mainRole":"Rolle","skills":["s1","s2","s3"],"languages":["l1","l2"]}` }],

        response_format: { type: 'json_object' }

      })

    });

    const d = await res.json();

    profile = JSON.parse(d.choices[0].message.content);

  } catch(e) {}

  return {

    statusCode: 200,

    headers: { 'Access-Control-Allow-Origin': '*' },

    body: JSON.stringify({ profile, jobs: realJobs })

  };

};


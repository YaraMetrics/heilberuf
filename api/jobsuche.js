exports.handler = async (event) => {
  const params = JSON.parse(event.body || '{}');
  const { berufsfeld = 'Pflege', ort = '', umkreis = 50, page = 1 } = params;

  try {
    const url = new URL('https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs');
    url.searchParams.set('was', berufsfeld);
    if (ort) url.searchParams.set('wo', ort);
    url.searchParams.set('umkreis', umkreis);
    url.searchParams.set('page', page);
    url.searchParams.set('size', 10);

    const res = await fetch(url.toString(), {
      headers: {
        'X-API-Key': 'jobboerse-jobsuche',
        'Accept': 'application/json'
      }
    });

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data)
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

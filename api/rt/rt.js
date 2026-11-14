export default async function handler(req, res) {
  const FEEDS = new Set(['VehiclePosition', 'TripUpdate', 'Alert']);
  const feed = req.query.feed;

  if (!FEEDS.has(feed)) return res.status(404).send('Unknown feed');

  const RT_BASE = 'https://gtfsproxy.e-tam.fr/COMMON/';
  
  try {
    const upstream = await fetch(`${RT_BASE}${feed}.pb`, { 
        signal: AbortSignal.timeout(6000) 
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    
    const arrayBuffer = await upstream.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    
    // Optimisation Vercel pour rendre la carte très rapide
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10'); 
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('X-Feed-Source', 'live');
    
    return res.status(200).send(bytes);
  } catch (error) {
    console.error(`Erreur flux ${feed}:`, error.message);
    // On renvoie une erreur propre sans chercher de fichiers locaux (qui faisaient crasher Vercel)
    return res.status(500).json({ error: "Source officielle TAM indisponible" });
  }
}

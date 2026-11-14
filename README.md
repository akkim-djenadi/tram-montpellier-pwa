<p align="center"><img src="logo.png" alt="Park'MTP" width="220"></p>

# Tram Montpellier — PWA temps réel

Carte des tramways (lignes 1 à 5) et des bus (39 lignes, à activer au choix dans l'onglet *Lignes*) de Montpellier avec position des véhicules, prochains passages, arrêts
autour de l'utilisateur, alertes et tarifs. Installable (PWA) et utilisable hors ligne.
Leaflet + OpenStreetMap, aucune dépendance npm.

## Lancer

```bash
npm start        # http://localhost:8080  (la géolocalisation exige HTTPS ou localhost)
npm test         # 30 tests (décodeur GTFS-RT, moteur d'horaires, géométrie, temps réel)
```

## Comment les données sont utilisées

| Fichier fourni | Usage |
|---|---|
| `GTFS/` (routes, trips, stop_times, stops, calendar_dates) | `npm run build:data` → `data/network.json` : 44 lignes, 625 stations, 51 838 trajets (3,5 Mo, 610 Ko compressé). Sert de repli quand le direct est indisponible. Les 714 trajets « TAD » (sur réservation) sont exclus. |
| `MMM_MMM_LigneTram.json` | Tracé officiel des tramways ; les arrêts y sont projetés pour interpoler les positions théoriques. Les bus n'ont pas de tracé dans les données : leurs lignes sont dessinées d'arrêt en arrêt (segments droits). |
| `VehiclePosition.pb`, `TripUpdate.pb`, `Alert.pb` | Copiés dans `fixtures/` : jeu de test du décodeur et mode « Instantané fourni ». |
| `GTFS/fare_*.txt`, `ticketing_deep_links.txt` | Onglet Infos : tarifs et lien m-ticket. |

## Itinéraires (onglet Trajet)

Choisissez un arrêt de départ et d'arrivée (ou « Partir d'ici / Aller ici » depuis une fiche d'arrêt, ou le bouton
⌖ pour partir de votre position), puis « maintenant » ou une heure. Le calcul (`src/router.js`, algorithme RAPTOR)
renvoie l'heure d'arrivée à la minute, avec correspondances (jusqu'à 4) et marche entre arrêts voisins (≤ 300 m) :
le plus rapide, le moins de correspondances, puis les départs suivants. Il se base sur les horaires théoriques du GTFS ;
le premier départ est comparé au temps réel quand il est disponible (retard affiché, arrivée estimée pour un trajet direct).
Le tracé s'affiche sur la carte.

## Trois sources de positions (onglet Infos)

1. **Automatique** : flux GTFS-RT TaM s'il est frais (< 3 min), sinon horaires théoriques.
2. **Instantané fourni** : les fichiers `.pb` joints (positions figées, trams grisés).
3. **Horaires théoriques** : positions calculées depuis le GTFS, fonctionne hors ligne.

Le bandeau en haut indique toujours la source réellement affichée.

## Flux temps réel officiel

Source : `https://gtfsproxy.e-tam.fr/COMMON/{VehiclePosition,TripUpdate,Alert}.pb` (rafraîchi ~10 s).
Ce serveur n'envoie pas d'en-tête CORS : un navigateur ne peut pas l'appeler directement, il faut
passer par le proxy `/api/rt/{feed}` de `server.local.mjs` (`RT_BASE=https://…/ npm start` pour changer la
source). Si la source ne répond pas, le proxy sert l'instantané fourni (en-tête `X-Feed-Source: snapshot`,
jamais présenté comme du direct). Hébergement statique sans Node : l'app reste en horaires théoriques.

## Déploiement

Servir en **HTTPS** (requis pour installation + géolocalisation). `server.local.mjs` n'est nécessaire que
pour le proxy CORS ; sans lui il n'y a pas de direct (horaires théoriques seulement). Mettre à jour les
horaires : remplacer `GTFS/` puis `npm run build:data` (et incrémenter `VERSION` dans `sw.js`).

Données : TaM / Montpellier Méditerranée Métropole (ODbL) · Fond © contributeurs OpenStreetMap.

# Metz à pied

PWA (Progressive Web App) qui génère un parcours personnalisé des lieux à voir à Metz, installable sur Android et utilisable hors ligne pendant la visite.

HTML/CSS/JavaScript vanilla, sans framework ni étape de build. Carte Leaflet + tuiles OpenStreetMap.

## Contenu

| Fichier | Rôle |
|---|---|
| `index.html` | Questionnaire et écran de parcours |
| `style.css` | Thème pierre de Jaumont et vitraux, mode sombre automatique |
| `app.js` | Sélection des lieux, ordre de visite par voyageur de commerce (exact jusqu'à 15 étapes), horaires, GPS, suivi de visite |
| `data/lieux.json` | 30 lieux + 6 adresses de pause (coordonnées vérifiées sur OpenStreetMap) |
| `data/distances.json` | Distances réelles à pied entre tous les points (OSM) |
| `manifest.webmanifest` | Métadonnées d'installation |
| `service-worker.js` | Cache de l'app, des données, de Leaflet et des tuiles déjà vues |
| `icons/` | Icônes 192, 512 et maskable 512 |
| `images/` | Une photo par lieu (Wikimedia Commons, crédits dans `lieux.json`) |

Les préférences, le parcours en cours et les lieux visités sont stockés dans le `localStorage` du téléphone.

## Lancer en local

Depuis le dossier du projet :

```bash
python -m http.server 8000
```

Puis ouvrir <http://localhost:8000>. `localhost` compte comme contexte sécurisé : le service worker et la géolocalisation y fonctionnent.

> Ne pas ouvrir `index.html` en double-cliquant (`file://`) : le chargement de `lieux.json` et le service worker ne fonctionnent pas dans ce mode.

## Déployer sur GitHub Pages

Une PWA doit être servie en HTTPS pour être installable ; GitHub Pages le fait gratuitement. Tous les chemins sont relatifs et le service worker a pour portée `./`, l'app fonctionne donc sous `https://<utilisateur>.github.io/metz-a-pied/`.

### Avec GitHub CLI (`gh`)

```bash
gh auth login
```

```bash
gh repo create metz-a-pied --public --source=. --remote=origin --push
```

```bash
gh api -X POST repos/{owner}/metz-a-pied/pages -f "source[branch]=main" -f "source[path]=/"
```

### Sans `gh`

1. Créer un dépôt public vide `metz-a-pied` sur <https://github.com/new> (sans README).
2. Pousser le code :

```bash
git remote add origin https://github.com/<utilisateur>/metz-a-pied.git
```

```bash
git push -u origin main
```

3. Sur GitHub : **Settings → Pages → Build and deployment → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`, **Save**.
4. Après 1 à 2 minutes, l'app est en ligne sur `https://<utilisateur>.github.io/metz-a-pied/`.

### Mettre à jour l'app

Après une modification, incrémenter `VERSION` en haut de `service-worker.js` (actuellement `v4`), puis commit et push. Sur le téléphone, la nouvelle version s'affiche au deuxième lancement (la première ouverture télécharge la mise à jour en arrière-plan).

## Installer sur Android

1. Ouvrir l'URL GitHub Pages dans **Chrome**.
2. Menu **⋮** → **Ajouter à l'écran d'accueil** (ou **Installer l'application**), puis confirmer.
3. Lancer l'app depuis son icône : elle s'ouvre en plein écran, sans barre d'adresse.

Conseils pour la visite :
- Avant de partir (au Wi-Fi de l'hôtel par exemple), générez votre parcours et faites défiler/zoomer la carte sur les zones du parcours : les tuiles consultées restent disponibles hors ligne (jusqu'à environ 1 500 tuiles).
- Autorisez la localisation quand Chrome la demande, pour voir le point bleu. En cas de refus, l'app reste utilisable ; pour réactiver : cadenas à gauche de l'adresse → Autorisations → Position (ou, pour l'app installée, Paramètres Android → Applications → Metz à pied → Autorisations).

## Installer sur iPhone

1. Ouvrir l'URL GitHub Pages dans **Safari**.
2. Bouton **Partager** (carré avec une flèche vers le haut), puis **Sur l'écran d'accueil**, puis **Ajouter**.
3. Lancer l'app depuis son icône : elle s'ouvre en plein écran, sans la barre de Safari.

Depuis iOS 16.4, l'ajout fonctionne aussi depuis Chrome sur iPhone (même bouton Partager). Autoriser la localisation au premier lancement ; sinon : Réglages → Confidentialité et sécurité → Service de localisation.

## Optionnel : générer un .apk avec PWABuilder

1. Ouvrir <https://www.pwabuilder.com> et coller l'URL GitHub Pages de l'app.
2. Laisser l'analyse se terminer (le manifest, le service worker et les icônes sont déjà conformes).
3. **Package for stores → Android → Generate Package**. Le zip contient un `.apk` signé de test et un `.aab` pour le Play Store.
4. Copier l'`.apk` sur le téléphone et l'installer (autoriser l'installation depuis des sources inconnues pour l'application qui l'ouvre).

Pour supprimer la barre d'adresse dans l'APK, publier aussi le fichier `assetlinks.json` fourni par PWABuilder dans `.well-known/` à la racine du domaine (voir la doc PWABuilder ; sur un sous-dossier GitHub Pages, cela nécessite un domaine personnalisé ou un dépôt `<utilisateur>.github.io`).

## Données

Les coordonnées ont été vérifiées sur OpenStreetMap (Nominatim) le 30/10/2026. **Les horaires, tarifs et adresses de pause sont indicatifs : à confirmer sur place.** Pour ajouter un lieu, compléter `data/lieux.json` avec les champs :

```json
{
  "id": "identifiant-unique",
  "nom": "Nom affiché",
  "lat": 49.12, "lng": 6.17,
  "categories": ["histoire", "architecture", "art", "religieux", "nature", "gastronomie", "shopping", "photo", "nuit"],
  "duree": 20, "payant": false, "importance": 1,
  "description": "…", "aRegarder": "…", "anecdote": "…", "photo": "…",
  "note": "facultatif"
}
```

Pour une adresse de pause, ajouter `"type": "pause"` et `"pause": ["cafe", "dejeuner", "gouter"]` (au moins un). `importance` (1 à 3) favorise les incontournables.

### Ordre des étapes (voyageur de commerce)

- **Distances réelles à pied** : `data/distances.json` contient la matrice des distances piétonnes entre tous les lieux, la gare et les parkings, calculée sur les rues OpenStreetMap (OSRM, profil piéton). Pour un départ GPS, la première étape utilise le vol d'oiseau × 1,3.
- **Ordre optimal** : l'ordre de visite minimise la distance totale à pied, sans retour au point de départ. Jusqu'à 15 étapes par jour, il est exact (programmation dynamique de Held-Karp) ; au-delà, l'app enchaîne plusieurs départs « plus proche voisin » améliorés par 2-opt et Or-opt.
- **Tracé sur la carte** : en ligne, le parcours suit les rues (service de routage piéton routing.openstreetmap.de, qui reçoit les coordonnées des étapes et du point de départ, y compris la position GPS si vous l'avez choisie) ; hors ligne, il est dessiné en lignes droites.

Pour recalculer la matrice après avoir ajouté un lieu, interroger `https://routing.openstreetmap.de/routed-foot/table/v1/driving/<lng,lat;…>?annotations=distance` avec les points dans l'ordre de `ids` (gare, parkings, puis lieux).

### Photos

Chaque lieu a une photo libre de droits issue de Wikimedia Commons (dossier `images/`, 800 px max), avec l'auteur et la licence affichés sous la photo dans la fiche (champs `image`, `imageCredit`, `imageUrl` de `lieux.json`). Les photos des pauses sont des illustrations (plat, quartier), pas l'établissement lui-même. Elles sont mises en cache à l'installation pour rester visibles hors ligne.

Données cartographiques © contributeurs OpenStreetMap.

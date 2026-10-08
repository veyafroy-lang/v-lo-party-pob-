# VELO PARTY POBE — version production Render + Supabase

Cette version remplace SQLite par **Supabase PostgreSQL** pour que les codes, tickets et validations restent persistants sur Render.

## Fonctionnement

- L'administrateur se connecte avec `davicon.bj@gmail.com` (ou l'adresse définie dans `ADMIN_EMAIL`).
- Il génère des codes uniques associés à 2 000 / 5 000 / 10 000 / 15 000 / 20 000 FCFA.
- Un code est **à usage unique** : une transaction PostgreSQL crée le ticket et marque le code `USED` en même temps.
- Le visiteur saisit le code et le nom du bénéficiaire.
- Le ticket est généré en PNG avec logo, catégorie, prix, numéro unique et QR.
- Le QR est validé par `/scan.html` et une transaction PostgreSQL empêche une double validation.
- Aucun paiement en ligne n'est intégré.

## 1. Créer la base Supabase

1. Crée un projet sur Supabase.
2. Ouvre **SQL Editor**.
3. Copie-colle tout le contenu de `supabase/schema.sql`.
4. Exécute le script.
5. Dans **Project Settings > API**, récupère :
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

**Ne mets jamais la service_role key dans le navigateur, GitHub public ou le code frontend. Elle reste uniquement dans les variables d'environnement Render.**

## 2. Préparer le mot de passe admin

En local :

```bash
npm install
npm run hash-password -- "TON_MOT_DE_PASSE"
```

Copie le hash obtenu dans `ADMIN_PASSWORD_HASH` sur Render.

## 3. Variables Render

Ajoute ces variables dans Render > Environment :

```text
NODE_ENV=production
JWT_SECRET=une-longue-cle-aleatoire-d-au-moins-32-caracteres
ADMIN_EMAIL=davicon.bj@gmail.com
ADMIN_PASSWORD_HASH=ton-hash-bcrypt
EVENT_NAME=VELO PARTY POBE
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=ta-service-role-key
```

`PORT` est fourni automatiquement par Render ; ne le force pas si Render le gère.

## 4. Déploiement Render

- Runtime : Node
- Build Command : `npm install`
- Start Command : `npm start`

Le fichier `server.js` écoute automatiquement le port fourni par Render.

## Pages

- `/` — accueil
- `/get-ticket.html` — obtention du ticket
- `/admin.html` — administration
- `/scan.html` — contrôle QR
- `/api/health` — test serveur + base

## Important avant l'événement

Fais un test complet :

1. Générer un code dans l'admin.
2. Utiliser le code une première fois → ticket créé.
3. Réutiliser le même code → refus.
4. Scanner le QR → entrée validée.
5. Scanner le même QR une deuxième fois → refus.
6. Redémarrer/redéployer Render et vérifier que les données sont toujours présentes.
7. Vérifier les sauvegardes Supabase et les accès admin.

Cette version est conçue pour Render + Supabase. Elle ne dépend plus de `better-sqlite3`.


## Configuration administrateur simplifiée

Pour Render, tu peux maintenant utiliser `ADMIN_PASSWORD` directement. Le serveur le transforme en hash bcrypt en mémoire au démarrage. Ne mets jamais le mot de passe dans GitHub : ajoute-le uniquement dans les Environment Variables de Render. `ADMIN_PASSWORD_HASH` reste accepté si tu préfères utiliser un hash bcrypt.

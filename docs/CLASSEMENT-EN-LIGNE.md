# Classement en ligne — mise en route

Le jeu fonctionne parfaitement **sans** classement : tant que la
configuration est vide, aucune requête réseau n'est faite et les boutons
correspondants restent masqués. Ce document explique comment l'activer.

Compte à créer : **un seul, le tien**. Les joueurs, eux, n'ont rien à
créer — pas de compte, pas de mot de passe.

---

## 1. Créer le projet

1. Va sur <https://supabase.com>, crée un compte, puis un projet
   (l'offre gratuite suffit largement pour une bande d'amis).
2. Choisis une région proche de tes joueurs.
3. Note le mot de passe de la base — tu n'en auras pas besoin ici, mais
   Supabase le réclame à la création.

## 2. Créer la table et la vue

Dans le projet : **SQL Editor** → **New query**, colle ceci, puis **Run**.

```sql
-- Un score par joueur, par morceau, par difficulté et par mode.
-- La clé primaire fait tout le travail : republier ÉCRASE la ligne.
create table if not exists public.scores (
  player_id  uuid    not null,
  track_id   text    not null,
  diff       text    not null,
  keys       text    not null default '4',
  name       text    not null,
  avatar     text,
  score      int     not null,
  grade      text    not null,
  precision  numeric not null,
  combo      int     not null,
  mods       text[]  not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (player_id, track_id, diff, keys),

  -- Garde-fous : ils n'empêchent pas la triche déterminée, mais ils
  -- rejettent les valeurs impossibles.
  constraint score_plausible     check (score >= 0 and score <= 2000000),
  constraint precision_plausible check (precision >= 0 and precision <= 1),
  -- Le combo est pondéré par le fever depuis la v1.35 : une chaîne
  -- complète sur une chart longue dépasse largement 10 000.
  constraint combo_plausible     check (combo >= 0 and combo <= 200000),
  constraint grade_connu         check (grade in ('SS','S+','S','A','B','C','D')),
  constraint mode_connu          check (keys in ('2','4')),
  constraint nom_court           check (char_length(name) between 1 and 12),
  constraint avatar_court        check (avatar is null or char_length(avatar) <= 24)
);

create index if not exists scores_par_chart
  on public.scores (track_id, diff, keys, score desc);

-- Classement général : le calcul est fait par la base, le jeu n'affiche.
create or replace view public.leaderboard as
select
  player_id,
  max(name)                                   as name,
  -- L'avatar de la ligne la PLUS RÉCENTE : en changer doit se voir tout de
  -- suite, alors qu'un max() renverrait le dernier dans l'ordre alphabétique.
  (array_agg(avatar order by updated_at desc))[1] as avatar,
  count(*) filter (where grade = 'SS')        as ss,
  count(*) filter (where grade = 'S+')        as splus,
  count(*) filter (where grade = 'S')         as s,
  max(combo)                                  as max_combo,
  count(*)                                    as charts
from public.scores
group by player_id;

-- Accès public en lecture et en écriture (jeu sans inscription).
alter table public.scores enable row level security;

create policy "lecture publique"  on public.scores for select using (true);
create policy "ecriture publique" on public.scores for insert with check (true);
create policy "maj publique"      on public.scores for update using (true) with check (true);

grant select on public.leaderboard to anon;
```

## 2 bis. Mettre à jour une base déjà en service

Si tu as créé la table **avant la version 1.35**, il lui manque la colonne
`avatar` et sa contrainte de combo est trop étroite (le fever multiplie
désormais le combo : une chaîne complète dépasse largement 5 000). Colle
ceci dans le SQL Editor, puis **Run** — c'est sans risque, rien n'est
effacé :

```sql
alter table public.scores add column if not exists avatar text;

alter table public.scores drop constraint if exists avatar_court;
alter table public.scores add constraint avatar_court
  check (avatar is null or char_length(avatar) <= 24);

alter table public.scores drop constraint if exists combo_plausible;
alter table public.scores add constraint combo_plausible
  check (combo >= 0 and combo <= 200000);

-- Sans cette politique, les mises à jour (renommage, avatar) sont
-- silencieusement ignorées : la base répond 204 et ne change rien.
drop policy if exists "maj publique" on public.scores;
create policy "maj publique" on public.scores
  for update using (true) with check (true);

create or replace view public.leaderboard as
select
  player_id,
  max(name)                                       as name,
  (array_agg(avatar order by updated_at desc))[1] as avatar,
  count(*) filter (where grade = 'SS')            as ss,
  count(*) filter (where grade = 'S+')            as splus,
  count(*) filter (where grade = 'S')             as s,
  max(combo)                                      as max_combo,
  count(*)                                        as charts
from public.scores
group by player_id;

grant select on public.leaderboard to anon;
```

La politique de mise à jour mérite une mention à part : sans elle,
PostgREST répond « tout va bien » (204) à chaque renommage ou changement
d'avatar… sans rien modifier. C'est la panne la plus trompeuse du lot, et
la seule que le jeu ne peut pas deviner sans écrire pour de bon — c'est
justement ce que fait **VÉRIFIER LE CLASSEMENT** (voir plus bas).

Tant que cette migration n'est pas jouée, **le jeu continue de fonctionner** :
il détecte les refus de la base et republie sans l'avatar, puis avec le combo
ramené sous l'ancienne limite — classements compris. Tout se remet en place
de soi-même dès que le SQL ci-dessus est passé : les joueurs n'ont rien à
faire, la synchronisation du lancement s'en charge.

## 3. Brancher le jeu

`js/online-config.js` est **déjà renseigné** avec l'URL du projet et sa clé
publique. Les deux formats de clé sont acceptés : les anciennes clés
« anon » (des JWT, commençant par `eyJ`) et les nouvelles
(`sb_publishable_…`). Seules les premières sont envoyées en en-tête
`Authorization` — les secondes n'étant pas des jetons JWT, les envoyer
ainsi ferait échouer l'analyse côté serveur.

Une fois le SQL de l'étape 2 exécuté, **CLASSEMENT GÉNÉRAL** et **MES
SCORES** apparaissent dans la fiche de chaque morceau, **CLASSEMENT** sur
l'accueil (le classement de tous les joueurs), et **PUBLIER MES SCORES**
dans les réglages.

### Vérifier que ça marche

**Réglages → VÉRIFIER LE CLASSEMENT** fait le tour en une fois et affiche
un rapport ligne par ligne : table joignable, colonne `avatar` dans la
table *et* dans la vue, nombre de tes scores publiés, et — le plus
important — un vrai test d'écriture suivi d'une relecture.

Ce test d'écriture est là parce que trois pannes différentes produisent
exactement le même symptôme (« mon avatar ne change pas ») et que deux
d'entre elles ne remontent aucune erreur :

| Ce que dit le rapport | Ce qui manque |
|---|---|
| Colonne « avatar » ABSENTE de la table | l'`alter table` |
| Colonne « avatar » ABSENTE de la vue | le `create or replace view` |
| La base accepte l'écriture mais ne change rien | la politique `maj publique` |

Quand tout est vert, le rapport ne propose aucun SQL, et il en profite
pour reposer ton avatar sur toutes tes lignes déjà publiées.

### Vérifier à la main

1. Ouvre le jeu, va dans **Réglages → PUBLIER MES SCORES**.
2. Un message confirme le nombre de scores envoyés.
3. Dans Supabase, **Table Editor → scores** : les lignes doivent y être.

Si le message annonce une erreur, c'est presque toujours que le SQL de
l'étape 2 n'a pas été exécuté (la table `scores` ou la vue `leaderboard`
n'existe pas), ou que les politiques d'accès manquent.

---

## Comment ça marche

- **Avatar** : choisi dans les réglages, il voyage avec le pseudo et
  s'affiche devant lui dans les deux classements. Quatre sont offerts ; les
  six autres sont adossés aux trophées les plus exigeants du jeu (combo de
  1000, 25 grades SS, 10 full combos en HARD…). Le jeu ne retient que des
  identifiants qu'il connaît : une valeur inattendue venue de la base
  s'affiche sans avatar plutôt que de fabriquer une URL d'image.
- **Identité** : un identifiant est tiré au hasard sur l'appareil au premier
  envoi, puis conservé à part des réglages (il survit aux mises à jour). Le
  pseudo des réglages sert uniquement d'affichage.
- **Changement de pseudo** : dès que le champ du pseudo cesse de changer
  (une seconde environ), TOUTES les lignes déjà publiées par ce joueur sont
  renommées d'un coup, et un message le confirme. Sans ça, seul le morceau
  rejoué aurait porté le nouveau nom : le joueur serait apparu sous deux
  pseudos selon les morceaux, et le classement général — qui agrège par
  `max(name)` — aurait affiché celui venant le plus loin dans l'alphabet,
  pas le plus récent. Si le renommage échoue (hors ligne), la prochaine
  publication le rattrape toute seule.
- **Envoi automatique** : au lancement du jeu, et après chaque partie dont
  le meilleur score local a changé. Le lancement compare une empreinte des
  scores à celle du dernier envoi : si rien n'a bougé, aucune requête n'est
  faite. C'est ce qui rattrape les parties jouées hors ligne.
- **Envoi manuel** : le bouton des réglages republie d'un coup tous les
  meilleurs scores locaux — pratique après avoir joué hors ligne, ou pour
  alimenter la base la première fois.
- **Hors ligne** : toute requête qui échoue est ignorée en silence. Le jeu
  n'attend jamais le réseau, et rien n'est perdu (les scores restent en
  local et repartiront au prochain envoi manuel).

## Ce que ce classement ne fait pas

Un jeu statique embarque forcément sa clé publique dans son code. Quelqu'un
de motivé peut donc envoyer un score arbitraire. Les contraintes ci-dessus
rejettent l'absurde (score négatif, précision supérieure à 100 %, grade
inventé), mais **rendre le classement inviolable demanderait un serveur qui
rejoue et valide chaque partie**. C'est un classement entre amis, et il est
dimensionné pour ça.

Autre limite : sans compte, changer de téléphone ou vider les données du
navigateur crée une nouvelle identité. Les anciens scores restent dans la
base sous l'ancien identifiant.

## Données conservées

Uniquement un pseudo choisi par le joueur, un identifiant aléatoire et des
résultats de partie. Aucune adresse e-mail, aucun identifiant d'appareil,
aucun traceur. Pour supprimer un joueur :

```sql
delete from public.scores where player_id = '...';
```

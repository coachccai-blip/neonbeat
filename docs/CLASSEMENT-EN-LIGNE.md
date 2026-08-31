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

Dans le projet : **SQL Editor** → **New query**, colle le script ci-dessous,
puis **Run**.

C'est le **script complet et rejouable** : il crée ce qui manque, met à
jour ce qui existe, et le relancer n'a aucun effet de bord. Que ta base
soit vierge ou déjà peuplée, c'est celui-ci qu'il faut passer — il n'y a
pas de « script de migration » séparé.

> Deux pièges valent d'être signalés, parce qu'ils ont réellement fait
> échouer des mises à jour :
>
> - `create or replace view` **refuse** d'insérer une colonne ailleurs
>   qu'à la fin de la liste (`cannot change name of view column "ss" to
>   "avatar"`). D'où le `drop view` puis `create view`.
> - `create policy` sans `drop policy if exists` échoue sur une base
>   existante (`policy already exists`).
>
> Dans l'éditeur SQL de Supabase, **tout le script s'exécute en une seule
> transaction** : une seule de ces erreurs annule le reste — colonne
> `avatar` comprise. C'est silencieux côté jeu, et c'est précisément ce
> que **VÉRIFIER LE CLASSEMENT** sert à débusquer.

```sql
-- ═══════════════════════════════════════════════════════════════════
--  NEONBEAT — classement en ligne (v1.53)
--  Script COMPLET et REJOUABLE : il crée ce qui manque et met à jour
--  ce qui existe. Le lancer deux fois de suite ne change rien.
--  Supabase → SQL Editor → New query → coller → Run.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. La table : un score par joueur, par morceau, par difficulté,
--       par mode. La clé primaire fait tout : republier ÉCRASE la ligne.
create table if not exists public.scores (
  player_id  uuid    not null,
  track_id   text    not null,
  diff       text    not null,
  keys       text    not null default '4',
  name       text    not null,
  score      int     not null,
  grade      text    not null,
  precision  numeric not null,
  combo      int     not null,
  mods       text[]  not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (player_id, track_id, diff, keys)
);

-- ── 2. Colonnes ajoutées après coup (bases créées avant la v1.34).
alter table public.scores add column if not exists avatar text;

-- ── 3. Garde-fous. Ils n'empêchent pas la triche déterminée, mais ils
--       rejettent l'impossible. On les repose à chaque exécution : c'est
--       ce qui met à jour une base ancienne sans avoir à y penser.
alter table public.scores drop constraint if exists score_plausible;
alter table public.scores drop constraint if exists precision_plausible;
alter table public.scores drop constraint if exists combo_plausible;
alter table public.scores drop constraint if exists grade_connu;
alter table public.scores drop constraint if exists mode_connu;
alter table public.scores drop constraint if exists nom_court;
alter table public.scores drop constraint if exists avatar_court;

alter table public.scores
  add constraint score_plausible     check (score >= 0 and score <= 2000000),
  -- Depuis la v1.35 le fever multiplie le combo : une chaîne complète sur
  -- une chart longue dépasse largement 10 000. L'ancienne limite de 5 000
  -- rejetait ces scores.
  add constraint combo_plausible     check (combo >= 0 and combo <= 200000),
  add constraint precision_plausible check (precision >= 0 and precision <= 1),
  add constraint grade_connu         check (grade in ('SS','S+','S','A','B','C','D')),
  -- v1.53 : le mode 6 keys arrive — sans le « 6 » ici, chaque publication
  -- d'un score 6 keys serait rejetée par la base.
  add constraint mode_connu          check (keys in ('2','4','6')),
  add constraint nom_court           check (char_length(name) between 1 and 12),
  add constraint avatar_court        check (avatar is null or char_length(avatar) <= 24);

create index if not exists scores_par_chart
  on public.scores (track_id, diff, keys, score desc);

-- ── 4. Classement général : le calcul est fait par la base, le jeu
--       n'affiche. DROP puis CREATE, jamais CREATE OR REPLACE : ce
--       dernier refuse d'insérer une colonne ailleurs qu'à la fin
--       (« cannot change name of view column »), ce qui faisait échouer
--       toute la migration — et donc annuler la transaction entière.
drop view if exists public.leaderboard;
create view public.leaderboard as
select
  player_id,
  max(name)                                        as name,
  -- L'avatar de la ligne la plus récente qui en porte un : en changer
  -- doit se voir tout de suite, là où max() renverrait le dernier dans
  -- l'ordre alphabétique.
  (array_agg(avatar order by updated_at desc)
     filter (where avatar is not null))[1]         as avatar,
  count(*) filter (where grade = 'SS')             as ss,
  count(*) filter (where grade = 'S+')             as splus,
  count(*) filter (where grade = 'S')              as s,
  max(combo)                                       as max_combo,
  count(*)                                         as charts
from public.scores
group by player_id;

-- ── 5. Accès public, en lecture ET en écriture : le jeu n'a pas de
--       comptes. DROP avant CREATE, sinon rejouer le script échoue sur
--       « policy already exists » et annule tout le reste.
alter table public.scores enable row level security;

drop policy if exists "lecture publique"  on public.scores;
drop policy if exists "ecriture publique" on public.scores;
drop policy if exists "maj publique"      on public.scores;

create policy "lecture publique"  on public.scores for select using (true);
create policy "ecriture publique" on public.scores for insert with check (true);
-- Sans CELLE-CI, changer de pseudo ou d'avatar ne remonte aucune erreur
-- et ne modifie rien : la base répond « 204 OK » et ignore la demande.
create policy "maj publique"      on public.scores for update using (true) with check (true);

grant select, insert, update on public.scores to anon, authenticated;
grant select on public.leaderboard to anon, authenticated;
```

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

1. Ouvre le jeu, va dans **Réglages → PUBLIER MES SCORES**.
2. Un message confirme le nombre de scores envoyés.
3. Dans Supabase, **Table Editor → scores** : les lignes doivent y être.

Si quelque chose cloche — avatar qui ne change pas, renommage sans effet,
score refusé —, la réponse est toujours la même : **repasser le script de
l'étape 2 en entier**. Il est rejouable, et il remet d'aplomb les trois
choses qui échouent en silence : la colonne `avatar` dans la table, la
même colonne dans la vue `leaderboard`, et la politique `maj publique`
sans laquelle la base répond « 204 OK » à des mises à jour qu'elle
ignore.

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

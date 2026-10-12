---
title: Politique de confidentialité
description: Ce que cette instance Nafyn enregistre à votre sujet, pourquoi, et pendant combien de temps.
updated: 2026-10-12
---

Nafyn est un logiciel auto-hébergé : cette page décrit ce que le logiciel enregistre et pourquoi. La
personne ou l'organisation qui fait tourner cette instance décide de tout le reste, et c'est elle qu'il faut
contacter au sujet de vos données.

<!--
  Notes pour l'opérateur (non affichées - les commentaires HTML sont retirés du rendu) :

  * Vous êtes responsable du traitement. Vous pouvez modifier cette page, et vous devez le faire si votre
    déploiement fait quoi que ce soit que Nafyn ne fait pas lui-même : analytics supplémentaires, reverse
    proxy qui journalise les requêtes, sauvegardes externalisées, création de comptes qui collecte une
    adresse e-mail, etc.
  * N'ajoutez PAS votre nom ni vos coordonnées ici. La page les affiche au-dessus de ce document à partir de
    NAFYN_PRIVACY_CONTROLLER / NAFYN_PRIVACY_CONTACT, pour qu'ils restent justes sans reconstruction.
  * Ce fichier est analysé au moment du build. Une modification nécessite un rebuild (bun run build) pour
    apparaître en production.
  * Les durées de conservation ci-dessous doivent correspondre au code : les écoutes brutes utilisent
    insights.rawEventRetentionDays (1095 jours par défaut), l'étagère des écoutes récentes utilise
    retention.recentlyPlayedDays (180 jours par défaut), les sessions expirent au bout de 7 jours. Si vous
    changez ces app_settings, changez aussi cette page.
-->

## Ce qui est enregistré

Tout reste sur le serveur et la base de données de cette instance. Rien de ce qui suit n'est vendu, transmis
à des annonceurs, ni utilisé pour vous profiler sur d'autres services.

### Votre compte

Nom d'utilisateur, nom affiché facultatif, avatar facultatif, vos permissions, et les identifiants Last.fm /
Discogs que vous choisissez de lier. Nécessaire pour avoir un compte.

*Conservé jusqu'à la suppression de votre compte.*

### Vos identifiants

Votre mot de passe sous forme de hash bcrypt (jamais le mot de passe lui-même), les passkeys que vous
enregistrez, et les jetons d'API que vous générez pour les applications Subsonic.

*Conservés jusqu'à ce que vous les supprimiez, ou jusqu'à la suppression de votre compte.*

### Connexions

Un enregistrement par connexion, contenant l'adresse IP et le user agent du navigateur utilisé, pour que
vous puissiez voir vos sessions actives et déconnecter un appareil perdu.

*Supprimé à l'expiration de la session (7 jours) ou peu après sa révocation.*

### Votre bibliothèque

Les morceaux auxquels vous avez accès et leur date d'ajout. Les fichiers audio sont partagés entre les
utilisateurs de l'instance, pas dupliqués par personne.

*Conservé jusqu'au retrait du morceau, ou jusqu'à la suppression de votre compte.*

### Playlists

Les playlists que vous créez, leurs membres, et qui a ajouté chaque morceau.

*Vos playlists sont supprimées avec votre compte ; les morceaux que vous avez ajoutés à la playlist de
quelqu'un d'autre restent, sans votre nom.*

### Demandes de téléchargement

Ce qui a été demandé, quand, et le résultat - l'historique des téléchargements de l'instance.

*Conservé comme trace de fonctionnement, votre compte en étant retiré lorsque vous le supprimez.*

### Écoutes récentes

Les derniers morceaux, albums et playlists depuis lesquels vous avez lancé la lecture, pour alimenter
l'étagère « écoutes récentes ».

*Supprimé automatiquement au bout de 6 mois.*

### Historique d'écoute

Désactivé sauf si vous l'activez. Une fois actif : ce que vous avez écouté, quand, et combien de temps -
c'est ce qui alimente vos statistiques, les Replay Mix et le bilan de fin d'année.

*Les écoutes individuelles sont supprimées au bout de 3 ans ; les statistiques qui en découlent sont
conservées jusqu'à ce que vous supprimiez votre historique ou votre compte. Désactiver l'option arrête
immédiatement tout nouvel enregistrement.*

### Préférences

Réglages d'affichage, de lecture et de Nafyn Unity, ainsi que votre choix concernant l'historique d'écoute.

*Conservé jusqu'à la suppression de votre compte.*

## Ce qui sort du serveur

Nafyn interroge des services externes pour trouver et identifier la musique. Ces appels transportent ce qui
est recherché ou téléchargé - jamais votre nom d'utilisateur, l'identifiant de votre compte, ni votre
historique d'écoute.

- L'instance **slskd / Soulseek** de l'opérateur, pour chercher et télécharger des fichiers. Votre compte
  Nafyn ne lui est pas communiqué ; les identifiants slskd appartiennent à l'opérateur.
- **MusicBrainz**, pour identifier enregistrements, sorties et artistes.
- **AcoustID**, qui reçoit l'empreinte audio d'un fichier téléchargé pour confirmer qu'il s'agit du bon
  enregistrement.
- **Les fournisseurs de métadonnées**, quand une recherche en a besoin : Deezer, iTunes et ReccoBeats
  systématiquement, ainsi que TheAudioDB, Discogs, Genius et Last.fm si l'opérateur a configuré leurs clés.
- **Cover Art Archive** et les serveurs d'images des fournisseurs ci-dessus, pour récupérer les pochettes.

Une recherche textuelle que vous saisissez est transmise telle quelle à ces fournisseurs. C'est la seule
donnée de cette liste sur laquelle vous avez la main directement.

## Vos droits

Le RGPD vous permet, à tout moment et sans avoir à vous justifier :

- **De voir tout ce qui est détenu à votre sujet** (art. 15).
- **De le récupérer dans un fichier exploitable ailleurs** (art. 20).
- **De corriger ce qui est inexact** (art. 16).
- **De faire supprimer définitivement votre compte et ses données** (art. 17).
- **De retirer votre consentement à l'historique d'écoute**, ce qui arrête l'enregistrement immédiatement
  (art. 7(3)).
- **De vous opposer au traitement ou de le limiter** (art. 18, 21).

L'accès, la portabilité, le consentement à l'historique d'écoute et la suppression du compte se font sans
intermédiaire, dans **Paramètres → Confidentialité et sécurité**.

Si l'opérateur de cette instance ne donne pas suite à une demande, vous pouvez saisir l'autorité de
protection des données de votre pays (en France, la CNIL).

## Sécurité

Les mots de passe sont stockés sous forme de hash bcrypt. Les sessions sont des jetons signés, révocables
individuellement. Le fait que cette instance soit joignable en HTTPS, qui a accès à sa base de données et
comment elle est sauvegardée dépendent entièrement de son opérateur : demandez-lui si vous avez besoin de le
savoir.

Une exception à connaître : les jetons d'API pour les applications Subsonic sont stockés en clair, car
l'authentification du protocole Subsonic l'exige. Traitez-en un comme un mot de passe et révoquez-le si un
appareil est perdu.

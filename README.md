# WordKeep

A vocabulary revision app for ISEE Upper Level words. Every word has a meaning and a sample sentence, and every answer sorts the word into **Mastered** or **Working on**. Words come back for retesting automatically.

**1,467 words**: the 1,199 words of the 1,200-word master list plus 268 extra words from the earlier progress buckets (all with a meaning and sentence).

## How it works

- **Today**: a daily session. Words that are due for a retest come first, then a few new words. New words are shown on flashcards, then quizzed at the end of the session.
- **Cards**: flip-through flashcards for any set of words (Working on, Mastered, not yet seen, a group, everything).
- **Quiz**: 10, 20 or 30 questions from any set. Answers count toward the buckets.
- **Words**: search and filter the whole list. Open a word to see its meaning, sentence and retest date.
- **Progress**: counts, the last 7 days, a 14-day chart, the words to focus on, the retest schedule, settings and sharing.

Three kinds of question are mixed: *What does the word mean?*, *Which word fits this meaning?* and *Which word completes the sentence?* There is an "I don't know" button, which counts as a miss without guessing.

## The buckets and retesting

| What happens | Result |
| --- | --- |
| Right answer on a new or Working on word | **Mastered**. First retest in 1 day |
| Right answer on a Mastered word that is due | Next retest later: 1, 3, 7, 14, then 30 days |
| Right answer on a Mastered word that is not yet due | Counted, schedule unchanged |
| Wrong answer on any word | **Working on**. Asked again a few questions later in the same session and in the next session |
| Right answer on a word that was just missed in the same session | Stays in Working on. One more right answer on another day makes it Mastered |

Mastered words that are due take up to half of each session, so they are never starved by a long Working on list. New words only fill the space left in the session. Both limits are in Progress &rarr; Settings (defaults: 20 questions, up to 10 new words).

## Starting point

On first launch you can **continue from the earlier progress** (28 words start as Mastered and 512 as Working on, all due for a retest) or **start fresh**.

## Seeing a child's progress (for parents)

Progress is saved only in the browser that was used (`localStorage`). A website cannot show it to anyone else, which is why sharing is built in:

1. On the child's device: **Progress &rarr; Download progress file** (or *Copy a text summary*), then send it by email or message.
2. On the parent's device: **Progress &rarr; View a progress file** and choose that file. The report opens without changing anything on that device.
3. *Load a file onto this device* replaces the progress on a device, for example when moving to a new phone.

Clearing the browser's data erases progress, so download a file now and then as a backup.

## Publish on GitHub Pages

1. Create a repository (for example `wordkeep`) and upload `index.html`, `styles.css`, `app.js` and `data.js`.
2. Settings &rarr; Pages &rarr; Deploy from a branch &rarr; `main` and `/ (root)`.
3. The site appears at `https://YOUR-USERNAME.github.io/wordkeep/`.

To try it locally, open `index.html`, or run `python3 -m http.server` in this folder.

## Keep it private

The word list, meanings and sentences for the 1,200 master words came from a file you provided. Keep the repository **private** (GitHub Pages on a private repository needs a paid plan) or share the app only with your own family. The 268 extra words were written for this project.

## Editing the words

All content is in `data.js`, one line per word:

```
["Abdicate", "give up powers or duties", "The exhausted king chose to abdicate the throne.", 1, ""]
```

The fields are: word, meaning, sample sentence, ISEE group (0 = extra), earlier bucket (`M`, `W`, `H` or empty). Add new words at the end of the list so the order, and everyone's progress, stays the same. Progress is stored by the lower-case word, so keep each word unique. For fill-in-the-blank questions the sentence should contain the word exactly as written.

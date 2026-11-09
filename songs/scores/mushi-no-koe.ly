% 蟲のこゑ - Wikipedia 日本語版（CC BY-SA 4.0）
% https://ja.wikipedia.org/w/index.php?title=%E8%9F%B2%E3%81%AE%E3%81%93%E3%82%91&oldid=109578538
% The melody only, as the article has it; checked against the first songbook (API-SONGS S-2).
\relative {
    \set Staff.midiInstrument = #"piano"
	\key c \major
	\time 4/4
	\tempo 4 = 120
    \new Voice \relative c'' {
	g8 e8 a8 a8 g8 g8 e4 c'8 c8 a8 a8 g4 r4 g8 a8 g8 a8 g8 g8 g4 g8 e8 a8 a8 g8 g8 e4 \bar "|" \break
    c'8 c8 a8 a8 g4 r4 g8 a8 g8 a8 g8 g8 g4 g4 e8 a8 g8 g8 e8 e8 c'8 c8 b8 a8 g4 r4 \bar "|" \break
    c4 b8 a8 g8 g8 e4 a8 a8 g8 g8 c,4 r4 \bar "|."
    }
}

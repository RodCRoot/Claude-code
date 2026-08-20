#!/usr/bin/env python3
"""Generate WordPress (Gutenberg) block markup for the Teamwork Indiana pages.

Output: page-home.html, page-success-stories.html, page-faq.html
Paste each into the WP block editor via ⋮ menu -> Code editor.
Claude can also push these through the WordPress.com connector.
"""
import json, os, re, html

S = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(S)

BLUE, BLUE_BRIGHT = '#004CBA', '#2E7BFF'
GREEN, RED, PURPLE, YELLOW = '#009245', '#C1272D', '#662D91', '#FFE000'
NAVY, NAVY_DEEP = '#0C1A31', '#08101F'
IMG = '__MEDIA__'   # replace with Media Library URLs after upload


def group(inner, bg=None, text=None, extra_class='', layout='constrained'):
    style = ''
    cls = 'wp-block-group' + (f' {extra_class}' if extra_class else '')
    attrs = {'layout': {'type': layout}}
    if bg:
        attrs['style'] = {'color': {'background': bg}}
        if text:
            attrs['style']['color']['text'] = text
        style = f' style="background-color:{bg};'
        if text:
            style += f'color:{text};'
        style += 'padding:var(--wp--preset--spacing--70) var(--wp--preset--spacing--40)"'
        cls += ' has-background'
        if text:
            cls += ' has-text-color'
    return (f'<!-- wp:group {json.dumps(attrs, separators=(",", ":"))} -->\n'
            f'<div class="{cls}"{style}>{inner}</div>\n<!-- /wp:group -->')


def heading(text, level=2, color=None, size=None, align=None):
    a = {'level': level}
    st = ''
    cls = f'wp-block-heading'
    if color:
        a['style'] = {'color': {'text': color}}
        cls += ' has-text-color'
        st += f'color:{color};'
    if size:
        a['fontSize'] = size
        cls += f' has-{size}-font-size'
    if align:
        a['textAlign'] = align
        cls += f' has-text-align-{align}'
    st = f' style="{st}"' if st else ''
    return (f'<!-- wp:heading {json.dumps(a, separators=(",", ":"))} -->\n'
            f'<h{level} class="{cls}"{st}>{text}</h{level}>\n<!-- /wp:heading -->')


def para(text, color=None, size=None, align=None):
    a, st, cls = {}, '', ''
    if color:
        a['style'] = {'color': {'text': color}}
        cls += ' has-text-color'
        st += f'color:{color};'
    if size:
        a['fontSize'] = size
        cls += f' has-{size}-font-size'
    if align:
        a['textAlign'] = align
        cls += f' has-text-align-{align}'
    attr = ' ' + json.dumps(a, separators=(",", ":")) if a else ''
    st = f' style="{st}"' if st else ''
    c = f' class="{cls.strip()}"' if cls.strip() else ''
    return f'<!-- wp:paragraph{attr} -->\n<p{c}{st}>{text}</p>\n<!-- /wp:paragraph -->'


def button(text, url, bg=BLUE, color='#ffffff'):
    a = {'style': {'color': {'background': bg, 'text': color},
                   'border': {'radius': '6px'}}}
    return ('<!-- wp:buttons -->\n<div class="wp-block-buttons">\n'
            f'<!-- wp:button {json.dumps(a, separators=(",", ":"))} -->\n'
            f'<div class="wp-block-button"><a class="wp-block-button__link has-text-color '
            f'has-background wp-element-button" href="{url}" '
            f'style="border-radius:6px;color:{color};background-color:{bg}">{text}</a></div>\n'
            '<!-- /wp:button -->\n</div>\n<!-- /wp:buttons -->')


def columns(cols):
    inner = ''.join(
        f'<!-- wp:column -->\n<div class="wp-block-column">{c}</div>\n<!-- /wp:column -->'
        for c in cols)
    return f'<!-- wp:columns -->\n<div class="wp-block-columns">{inner}</div>\n<!-- /wp:columns -->'


def details(summary, content):
    return (f'<!-- wp:details -->\n<details class="wp-block-details">'
            f'<summary>{summary}</summary>{content}</details>\n<!-- /wp:details -->')


def spacer(h='40px'):
    return (f'<!-- wp:spacer {{"height":"{h}"}} -->\n'
            f'<div style="height:{h}" aria-hidden="true" class="wp-block-spacer"></div>\n'
            '<!-- /wp:spacer -->')


def image(url, alt, rounded=True):
    a = {'sizeSlug': 'large'}
    if rounded:
        a['style'] = {'border': {'radius': '14px'}}
    return (f'<!-- wp:image {json.dumps(a, separators=(",", ":"))} -->\n'
            f'<figure class="wp-block-image size-large">'
            f'<img src="{url}" alt="{alt}" style="border-radius:14px"/></figure>\n'
            '<!-- /wp:image -->')


def stat(n, label, color=BLUE_BRIGHT):
    return (heading(n, 3, color=color, size='large') +
            para(label, color='#93A2BE', size='small'))


def dots():
    d = ''.join(f'<span style="color:{c}">●</span>' for c in
                [BLUE, PURPLE, RED, YELLOW, GREEN])
    return para(d + ' ', size='small')


# ---------------------------------------------------------------- HOME
def build_home():
    b = []
    # hero
    hero = (para('BLOOMINGTON, INDIANA · SINCE 2014', color=BLUE_BRIGHT, size='small') +
            heading('Get faster &amp; jump higher in 30 days or less.', 1,
                    color='#ffffff', size='xx-large') +
            para('Personalized speed, vertical, and strength coaching for athletes of '
                 'every level — backed by science, technology, and a team that shows up '
                 'for you.', color='#93A2BE', size='medium') +
            spacer('20px') +
            button('Claim Your Free Assessment', '#contact'))
    offer = (para('NEW ATHLETE OFFER', color=YELLOW, size='small') +
             heading('Free Performance Assessment', 3, color='#ffffff') +
             heading('FREE <s style="opacity:.6;font-size:.5em">$99</s>', 2,
                     color='#ffffff', size='x-large') +
             para('Goal-setting &amp; injury-history planning with a coach, then real '
                  'testing on the turf.', color='#93A2BE') +
             '<!-- wp:list -->\n<ul class="wp-block-list">'
             '<li>Vertical jump assessment</li>'
             '<li>Hawkin Dynamics force-plate jump &amp; lower-body power testing</li>'
             '<li>Sprint speed testing &amp; first-step acceleration evaluation</li>'
             '<li>Personalized training recommendations</li>'
             '<li>No commitment, no pressure</li>'
             '</ul>\n<!-- /wp:list -->' +
             button('Book My Free Session', '#contact'))
    b.append(group(columns([hero, offer]), bg=NAVY_DEEP, text='#EAF0FA'))

    # trust strip
    stats = columns([
        stat('2014', 'COACHING SINCE'),
        stat('1,500+', 'ATHLETES TRAINED OVER 13 YEARS'),
        stat('100+', 'NCAA D1 ATHLETES TRAINED'),
        stat('300+', 'COLLEGIATE ATHLETES'),
        stat('CSCS', 'NSCA-CERTIFIED COACHES'),
    ])
    leagues = para(
        '<strong>Teamwork athletes have gone on to compete in</strong> &nbsp; ' +
        ' &nbsp; '.join(f'<span class="tw-league">{l}</span>'
                        for l in ['NCAA D1', 'NFL', 'WNBA', 'FIBA']),
        color='#EAF0FA', align='center')
    b.append(group(stats + spacer('20px') + leagues, bg=NAVY, text='#EAF0FA'))

    # method
    steps = [('01', 'Assess', 'Baseline your speed, vertical, and movement patterns with real data.'),
             ('02', 'Personalize', 'Build a plan around your sport, position, and specific gaps.'),
             ('03', 'Test', 'Train the four athletic demands and log every session.'),
             ('04', 'Reassess', 'Re-measure, prove the gains, and adjust the load.'),
             ('05', 'Recover', 'Dial in sleep, nutrition, and mobility so results stick.')]
    colors = [BLUE, PURPLE, RED, YELLOW, GREEN]
    method = columns([heading(n, 4, color=c) + heading(t, 4) + para(d, size='small')
                      for (n, t, d), c in zip(steps, colors)])
    b.append(group(dots() + heading('Five steps. Thirty days. Measurable gains.', 2, align='center') +
                   para('Every athlete moves through the same proven loop — so progress is '
                        'coached, tracked, and repeatable, never guessed.', align='center') +
                   spacer() + method))

    # five F's
    fs = [('Food', 'Nutrition as an investment — fueling training instead of dieting against it.', BLUE),
          ('Fun', 'Dynamic, varied sessions that keep athletes motivated and coming back.', GREEN),
          ('Function', 'Training that transfers to real life and lasts across every stage.', RED),
          ('Family', 'Kid-safe programming built on wellness, respect, and community.', PURPLE),
          ('Flow', 'Energized focus and full involvement — the state where athletes thrive.', YELLOW)]
    fcards = columns([heading('F', 3, color=c) + heading(t, 4, color='#ffffff') +
                      para(d, color='#93A2BE', size='small') for t, d, c in fs])
    b.append(group(heading('Performance is more than workouts.', 2, color='#ffffff', align='center') +
                   para('Everything we coach comes back to the Five F\'s — the pillars that '
                        'build athletes and people who last.', color='#93A2BE', align='center') +
                   spacer() + fcards, bg=NAVY_DEEP, text='#EAF0FA'))

    # pricing
    plans = [('Starter', '$129', 'Build the habit',
              ['1 session / week', 'Personalized plan', 'Progress tracking']),
             ('Athlete', '$189', 'Our best value — most popular',
              ['2 sessions / week', 'Speed + vertical focus', 'Nutrition guidance',
               'Monthly reassessment']),
             ('All-Access', '$249', 'Go all in',
              ['3 sessions / week', 'Everything in Athlete', 'Priority scheduling',
               'Recovery &amp; mobility add-ons'])]
    pcards = columns([
        heading(n, 3) + para(sub, size='small') +
        heading(p + '<span style="font-size:.4em">/mo</span>', 2, color=BLUE) +
        '<!-- wp:list -->\n<ul class="wp-block-list">' +
        ''.join(f'<li>{f}</li>' for f in feats) + '</ul>\n<!-- /wp:list -->' +
        button(f'Choose {n}', '#contact', bg=BLUE if n == 'Athlete' else NAVY)
        for n, p, sub, feats in plans])
    guarantee = group(
        para(f'<strong style="color:{GREEN}">30-DAY RISK-FREE GUARANTEE.</strong> '
             'If an athlete decides our program isn\'t the perfect fit in the first 30 '
             'days, you can walk away — no questions, no hard feelings.', align='center'),
        bg='#EEF2F9', extra_class='tw-guarantee')
    b.append(group(dots() + heading('Simple plans. Serious progress.', 2, align='center') +
                   para('You\'re not buying a month of gym — you\'re buying development, paid '
                        'monthly. 6- and 12-month training blocks earn the best rate; '
                        'month-to-month is available too.', align='center') +
                   spacer() + pcards + spacer('30px') + guarantee))

    # coaches
    coaches = [('Seth', 'Head Coach · NSCA-CSCS',
                'IU kinesiology &amp; exercise science grad, nearly a decade at Teamwork — '
                'holding the same certification required by NCAA and pro strength staffs.'),
               ('Rod Root', 'Co-Founder · CSCS · USAW',
                'Founded Teamwork in 2014 to coach the whole athlete. CSCS and USA '
                'Weightlifting certified — TPI in progress.'),
               ('Erin Parks', 'Co-Founder',
                'Thirteen years coaching adults and athletes — find her bright and early at '
                'the 6 AM and Saturday-morning sessions.'),
               ('Maddelyn "Madde" Miller', 'Assistant Coach · CSCS',
                'IU exercise science \'25 and a former Teamwork athlete — proof the '
                'leadership pipeline works.')]
    ccards = columns([heading(n, 4) + para(r, color=BLUE_BRIGHT, size='small') +
                      para(d, size='small') for n, r, d in coaches])
    b.append(group(dots() + heading('Coaches who show up for you.', 2, align='center') +
                   para('Certified, experienced, and invested in every rep — from Division 1 '
                        'prospects to first-time athletes.', align='center') +
                   spacer() + ccards))

    # reviews teaser
    quotes = [('Rhett Good', 'Google review · Member',
               'Love Teamwork Bloomington. I have been a member for 2 years and they have '
               'definitely gotten me on a healthier path… My entire family now works out here.'),
              ('Angela Lindauer', 'Google review · Parent',
               'The staff is fabulous and supportive. They want to see the athletes develop '
               'not only as an athlete but also as a human being.'),
              ('Chris Parker', 'Google review · Member',
               'Whatever your goals… Teamwork will help you set attainable goals for '
               'sustainable growth. Thanks Erin, Rod, Seth, Jordan, and Lauren!')]
    qcards = columns([para('★★★★★', color=YELLOW) + para(f'"{t}"') +
                      para(f'<strong>{n}</strong><br>{r}', size='small')
                      for n, r, t in quotes])
    b.append(group(heading('Proof, not promises.', 2, align='center') +
                   para('Real five-star Google reviews from Teamwork members and parents.',
                        align='center') + spacer() + qcards + spacer('30px') +
                   button('Read All Success Stories', '/success-stories', bg=NAVY),
                   bg='#EEF2F9'))

    # contact
    contact = (para('JOIN THE MOVEMENT', color=YELLOW, size='small') +
               heading('Your first session is on us.', 2, color='#ffffff') +
               para('Tell us your goals and we\'ll match you with a coach. You\'ll get a free '
                    'assessment, a plan, and a real look at what training here feels like.',
                    color='#93A2BE') +
               para('<strong>2013 S. Yost Ave, Bloomington, IN 47403</strong><br>'
                    'Call or text: <strong>(812) 445-5551</strong><br>'
                    'memberships@teamworkbloomington.com', color='#EAF0FA') +
               spacer('20px') +
               button('Book My Free Assessment', 'GHL_CALENDAR_URL'))
    b.append(group(contact, bg=NAVY_DEEP, text='#EAF0FA'))
    b.append('<!-- NOTE: replace GHL_CALENDAR_URL with the GoHighLevel calendar link. -->')
    return '\n\n'.join(b)


# ------------------------------------------------------- SUCCESS STORIES
def build_success():
    b = []
    b.append(group(dots() + heading('Real people. Real results.', 1, color='#ffffff',
                                    size='xx-large') +
                   para('Every quote on this page is a real, unedited Google review from a '
                        'Teamwork member, athlete, or parent. Every video is a real athlete '
                        'telling their own story.', color='#93A2BE', size='medium') +
                   para('★★★★★ Rated five stars on Google', color=YELLOW),
                   bg=NAVY_DEEP, text='#EAF0FA'))

    featured = (para('FEATURED STORY · HS ATHLETE → BIG TEN', color=BLUE, size='small') +
                para('★★★★★', color=YELLOW) +
                '<!-- wp:quote -->\n<blockquote class="wp-block-quote">' +
                para('"Rod and his team at TWB are as good as it gets. I started as an '
                     'inexperienced HS athlete looking to take my game to the next level and '
                     'TWB prepared me to become a Big Ten athlete… Not to mention they provide '
                     'the most welcoming environment a gym can have. Not only are you going to '
                     'better yourself athletically or fitness-wise by going, but you will '
                     'naturally build a lifelong community as well."') +
                '<cite>Cooper Bybee — Edgewood → Indiana University Men\'s Basketball</cite>'
                '</blockquote>\n<!-- /wp:quote -->' +
                group(para('<strong>Teamwork Bloomington</strong> · Owner', size='small') +
                      para('"Cooper, thank you for one of the most rewarding athlete/coach '
                           'relationships of my career! Your passion to get the very best out '
                           'of yourself was contagious! Your basketball career, from Edgewood, '
                           'to Junior College, to INDIANA UNIVERSITY MEN\'S BASKETBALL was '
                           'legendary… thanks for loving the process, my guy!" — Rod Root'),
                      bg='#EEF2F9'))
    b.append(group(featured))

    vids = columns([
        heading('Gavin Hodgson — Testimonial', 4, color='#ffffff') +
        para('ATHLETE INTERVIEW', color=BLUE_BRIGHT, size='small') +
        para('<a href="https://drive.google.com/file/d/1NrzW6ZS76DhdsoSNwZf9E0HUf2vsXSnR/view">'
             'Watch the video →</a>', color='#93A2BE'),
        heading('James Butcher — Athlete of the Week', 4, color='#ffffff') +
        para('ATHLETE FEATURE', color=BLUE_BRIGHT, size='small') +
        para('<a href="https://drive.google.com/file/d/1RE78lNMNNtwjN66hXe3CFncEP_yI-uQN/view">'
             'Watch the video →</a>', color='#93A2BE'),
    ])
    b.append(group(heading('Hear it from the athletes.', 2, color='#ffffff', align='center') +
                   para('Straight-from-the-turf video testimonials and athlete features.',
                        color='#93A2BE', align='center') + spacer() + vids,
                   bg=NAVY_DEEP, text='#EAF0FA'))

    reviews = json.load(open(f'{REPO}/../teamwork-indiana/wordpress/reviews.json')) \
        if os.path.exists(f'{S}/reviews.json') else None
    if reviews is None:
        reviews = json.load(open(f'{S}/reviews.json')) if os.path.exists(f'{S}/reviews.json') else []
    cards = ''.join(group(para('★★★★★', color=YELLOW) + para(f'"{r["text"]}"') +
                          para(f'<strong>{r["name"]}</strong> · {r["who"]}<br>'
                               '<em style="font-size:.8em">Verified Google review</em>',
                               size='small'), bg='#ffffff')
                    for r in reviews)
    b.append(group(dots() + heading('In their own words.', 2, align='center') +
                   para('Unedited five-star Google reviews from the Teamwork community.',
                        align='center') + spacer() + cards, bg='#EEF2F9'))

    b.append(group(heading('Your story starts with one free session.', 2, color='#ffffff',
                           align='center') +
                   para('Book a free assessment and see why these athletes and families never '
                        'left.', color='#93A2BE', align='center') +
                   button('Book My Free Assessment', '/#contact'),
                   bg=NAVY_DEEP, text='#EAF0FA'))
    return '\n\n'.join(b)


# ----------------------------------------------------------------- FAQ
def esc(t):
    """Escape bare ampersands without breaking existing entities."""
    return re.sub(r'&(?!#?\w+;)', '&amp;', t)


def inline_md(t):
    """Convert inline markdown to HTML. Bold before italic; escape & first."""
    t = esc(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)', r'<em>\1</em>', t)
    t = re.sub(r'\[(.+?)\]\((.+?)\)', r'<a href="\2">\1</a>', t)
    return t


def md_table(rows):
    """Markdown table rows -> WP table block."""
    body = ''.join(
        '<tr>' + ''.join(f'<td>{inline_md(c)}</td>' for c in r) + '</tr>'
        for r in rows)
    return ('<!-- wp:table -->\n<figure class="wp-block-table"><table><tbody>'
            f'{body}</tbody></table></figure>\n<!-- /wp:table -->')


def md_to_blocks(md):
    """Convert a markdown answer body into Gutenberg blocks, preserving order.

    Handles: paragraphs (hard-wrapped), bullet lists with continuation lines,
    markdown tables, and strips horizontal rules / trailing italic footers.
    """
    lines = md.split('\n')
    out, para_buf, list_buf, table_buf = [], [], [], []

    def flush_para():
        if para_buf:
            out.append(para(inline_md(' '.join(para_buf).strip())))
            para_buf.clear()

    def flush_list():
        if list_buf:
            items = ''.join(f'<li>{inline_md(x)}</li>' for x in list_buf)
            out.append('<!-- wp:list -->\n<ul class="wp-block-list">'
                       f'{items}</ul>\n<!-- /wp:list -->')
            list_buf.clear()

    def flush_table():
        if table_buf:
            rows = []
            for raw in table_buf:
                cells = [c.strip() for c in raw.strip().strip('|').split('|')]
                if all(re.fullmatch(r':?-{2,}:?', c) for c in cells):
                    continue          # separator row
                rows.append(cells)
            if rows:
                out.append(md_table(rows))
            table_buf.clear()

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if re.fullmatch(r'-{3,}', stripped):          # horizontal rule
            flush_para(); flush_list(); flush_table()
            continue
        if stripped.startswith('|'):                  # table row
            flush_para(); flush_list()
            table_buf.append(stripped)
            continue
        flush_table()
        if not stripped:                              # blank line
            flush_para(); flush_list()
            continue
        m = re.match(r'-\s+(.*)', stripped)
        if m:                                         # new bullet
            flush_para()
            list_buf.append(m.group(1))
            continue
        if list_buf and raw.startswith('  '):         # bullet continuation
            list_buf[-1] += ' ' + stripped
            continue
        flush_list()
        para_buf.append(stripped)

    flush_para(); flush_list(); flush_table()
    return ''.join(out)


def build_faq():
    src = open(f'{REPO}/FAQ-PARENTS-ATHLETES.md').read()
    b = [group(dots() + heading('Everything parents &amp; athletes ask us.', 1,
                                color='#ffffff', size='xx-large') +
               para('Straight answers about training, membership, and what to expect. '
                    'Can\'t find yours? Text us at (812) 445-5551 — a real coach answers.',
                    color='#93A2BE', size='medium'),
               bg=NAVY_DEEP, text='#EAF0FA')]

    section_colors = {'Getting Started': BLUE, 'Training': RED,
                      'Membership & Billing': GREEN, 'Location & Logistics': PURPLE,
                      'Results': YELLOW}
    out = []

    for block in re.split(r'\n(?=## )', src):
        m = re.match(r'## (.+)', block)
        if not m:
            continue
        name = m.group(1).strip()
        if name not in section_colors:
            continue
        items = []
        for q in re.split(r'\n(?=### )', block)[1:]:
            qm = re.match(r'### (.+?)\n(.*)', q, re.S)
            if not qm:
                continue
            question = esc(qm.group(1).strip())
            answer = qm.group(2)
            # drop the trailing italic sign-off line if present
            answer = re.sub(r'^\*[^*].*\*\s*$', '', answer, flags=re.M)
            content = md_to_blocks(answer.strip())
            if content:
                items.append(details(question, content))
        if items:
            out.append(group(
                heading(f'<span style="color:{section_colors[name]}">●</span> {esc(name)}', 2) +
                ''.join(items), extra_class='tw-faq'))
    b += out
    b.append(group(heading('Still have a question?', 3, align='center') +
                   para('Text (812) 445-5551 or message us — a real coach will get back to '
                        'you, usually within minutes.', align='center') +
                   button('Ask Us Anything', '/#contact'), bg='#EEF2F9'))
    return '\n\n'.join(b)


if __name__ == '__main__':
    # reviews for the success page
    if not os.path.exists(f'{S}/reviews.json'):
        scratch = '/tmp/claude-0/-home-user-Claude-code/744d8f8b-a649-5de6-8f45-af1b320fb8f2/scratchpad/reviews.json'
        if os.path.exists(scratch):
            open(f'{S}/reviews.json', 'w').write(open(scratch).read())
    pages = {'page-home.html': build_home(),
             'page-success-stories.html': build_success(),
             'page-faq.html': build_faq()}
    for fn, content in pages.items():
        open(f'{S}/{fn}', 'w').write(content)
        print(fn, len(content), 'bytes')

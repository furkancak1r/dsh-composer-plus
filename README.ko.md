# dsh-composer-plus — DeepSeek Harness용 Composer Plus

[![npm](https://img.shields.io/npm/v/dsh-composer-plus)](https://www.npmjs.com/package/dsh-composer-plus)
[![test](https://github.com/furkancak1r/dsh-composer-plus/actions/workflows/test.yml/badge.svg)](https://github.com/furkancak1r/dsh-composer-plus/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · [中文](README.zh.md) · [Türkçe](README.tr.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · **한국어** · [Bahasa Indonesia](README.id.md) · [Tiếng Việt](README.vi.md) · [हिन्दी](README.hi.md)

이 문서는 번역본입니다. 기준 문서는 영어 [README.md](README.md)입니다.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh) 데스크톱 앱과 웹 UI를 위한 Codex 스타일 편의 기능 모음입니다. 변경 사항 패널, 스와이프 카드로 보는 기능 아이디어, 메시지 본문까지 찾는 사이드바 검색, 파일 복원을 포함한 턴 되돌리기, 휴지통으로 보내는 채팅 삭제, 입력란 아래의 프로젝트 이름, 사이드바의 프로젝트 상태, 입력 기록, 계획 모드 단축키, 원클릭 계속, 재시작 후 실행 중이던 채팅 이어서 실행, 대기열 끌어서 놓기, 세션 딥링크, Markdown으로 채팅 내보내기, 채팅별 자동 검토 허용, 백그라운드 알림, Tether 앱을 통한 iPhone 접속, 자동 업데이트를 제공합니다.

**한 줄 요약:** DeepSeek Harness 플러그인 하나(npm `dsh-composer-plus`, 설정 → 플러그인에서 **Composer Plus**로 표시)로 다음 기능을 추가합니다. git 변경 사항 패널, Tinder 스타일 기능 아이디어 카드, 메시지 속 단어도 찾는 사이드바 검색, ↶ 턴 되돌리기(채팅만 또는 채팅과 파일), 채팅 삭제, 입력란 아래의 프로젝트 이름, ↑/↓ 입력 기록, Shift+Tab `/plan` 전환, 원클릭 ▶ 계속, 재시작 후 이어서 실행, 끌어서 놓는 대기열 순서 변경, 세션 링크 복사, Markdown으로 내보내기, 자동 검토의 “이 채팅에서 허용”, 백그라운드 알림, iPhone 접속(모바일 연결, Tether 앱), 11개 추가 인터페이스 언어, 자동 업데이트.

<p align="center"><img src="docs/images/hero.webp" width="820" alt="Composer Plus를 사용하는 DeepSeek Harness: 실행 중인 프로젝트는 사이드바에 회전 표시가 나타나고, 변경 사항 패널은 git diff를 보여 줍니다"></p>

비공식 커뮤니티 플러그인입니다. 네트워크 호출은 업데이트 확인(GitHub 릴리스와 npm 레지스트리)뿐입니다. 시작할 때 이 호출을 막으려면 **자동 업데이트**를 끄세요. **기능 아이디어**는 **기능 제안**을 클릭할 때만 채팅 자체의 모델을 호출합니다. **다음 메시지 예측**(기본값: 켜짐)은 턴이 끝날 때마다 설정에서 고른 모델(다른 모델을 고르지 않으면 dsh의 기본 모델)을 클릭 없이 한 번 호출합니다. 이 호출을 막으려면 **설정 → Composer Plus**에서 끄세요. **입력 중 자동 완성**(기본값: 꺼짐)은 사용자가 켠 뒤에 입력을 멈출 때마다 이 기능에서 고른 모델(기본값: 예측의 모델)을 호출합니다. **모바일 연결**(기본값: 꺼짐)은 사용자가 켠 뒤에만 로컬 네트워크나 tailnet에서 오는 iPhone 연결을 받습니다.

## 설치

**데스크톱 앱:** 설정 → 플러그인 → **플러그인 추가** → `dsh-composer-plus` 입력 → **지금 활성화**.
npm 이름 대신 `https://github.com/furkancak1r/dsh-composer-plus`를 붙여 넣어도 됩니다.

**웹 / CLI 프로필:**

```sh
dsh plugin --profile web add dsh-composer-plus
```

그런 다음 dsh를 다시 시작하세요. (CLI는 데스크톱 프로필에 설치할 수 없습니다. 데스크톱 프로필은 앱이 관리합니다.)

> dsh의 pnpm은 게시된 지 24시간이 지나지 않은 버전을 건너뜁니다. 릴리스 직후에는 버전을 붙여서 설치하세요: `dsh-composer-plus@1.11.0`.

## 기능

| 기능 | 사용 방법 | 스크린샷 |
|---|---|---|
| **변경 사항 패널** | 오른쪽 사이드바 → `+` → **변경 사항**. **커밋 안 됨**, **스테이징 안 됨**, **스테이징됨**, **브랜치** 중 하나를 고르면 변경된 파일이 `+/-` 개수와 함께 표시됩니다. 파일을 클릭하면 diff를 볼 수 있습니다. **마지막 턴**은 최근 턴에 대한 dsh 자체 검토 화면을 엽니다. | <a href="assets/features/changesPanel.webp"><img src="assets/features/changesPanel.webp" width="160" alt="변경 사항 패널 스크린샷"></a> |
| **기능 아이디어** | 오른쪽 사이드바 → `+` → **기능 아이디어** → **기능 제안**. 채팅 자체의 모델이 채팅 프로젝트의 짧은 요약(최상위 파일, README와 매니페스트의 앞부분, 최근 커밋 15개)을 읽고 기능을 최대 8개 제안합니다. 제안은 dsh UI 언어로 된 카드 묶음으로 표시됩니다. 카드를 오른쪽으로 스와이프하면(또는 **✓** 클릭, `→` 누르기. 어느 방법이든 카드가 그쪽으로 날아갑니다) 같은 프로젝트에서 새 채팅이 시작됩니다. 새 채팅은 그 아이디어를 요청으로 삼아 계획 모드로 시작하므로, 계획을 승인하기 전에는 아무것도 바뀌지 않습니다. 계획을 건너뛰려면 **▶ 바로 구현**을 클릭하세요(또는 `↑` 누르기. 카드가 위로 날아갑니다). 새 채팅이 그 아이디어를 일반 요청으로 삼아 바로 시작하고, 모델이 변경을 적용한 뒤 검사를 실행합니다(승인은 평소대로 적용됩니다). 건너뛰려면 왼쪽으로 스와이프하세요(또는 **✕**, `←`). **실행 취소**(또는 `Z`)는 건너뛴 카드를 되돌립니다. 좋은 아이디어를 나중을 위해 저장하려면 **↓**를 클릭하세요(또는 `↓` 누르기). 아이디어는 프로젝트의 **나중에** 목록에 들어갑니다. 같은 프로젝트 폴더의 모든 채팅에서 이 목록이 보입니다(재시작 후에도). **나중에(N)** 버튼은 목록을 엽니다. **계획하기**는 그 아이디어로 같은 계획 모드 채팅을 시작하고, **바로 구현**은 계획 없는 채팅을 시작합니다. 둘 다 아이디어를 목록에서 뺍니다. **모두 함께 계획 (N)** 버튼은 목록의 모든 아이디어로 계획 모드 채팅 하나를 시작하므로, 공통 부분은 한 번만 계획됩니다. **목록에서 제거**는 아이디어를 삭제합니다. **체크리스트로 복사**는 목록 전체를 Markdown 체크리스트(`- [ ] Title — Summary`, 아이디어마다 한 줄)로 클립보드에 복사합니다. 이슈 트래커나 TODO 파일에 쓸 수 있으며, 네트워크 요청은 하지 않습니다. **아이디어 더 받기**는 카드를 추가합니다. 한 분야에 대한 아이디어만 받으려면 **기능 제안** 옆 입력란에 짧은 **집중 주제**를 입력하거나(최대 80자, `Enter`로도 제안합니다), 그 아래의 고정 주제 **성능**, **접근성**, **테스트**, **보안**, **사용성**, **문서** 중 하나를 클릭하세요(다시 클릭하면 지워집니다). 그러면 모델은 그 주제에 관한 기능만 제안합니다. 입력란이 비어 있으면 어떤 기능이든 제안합니다. 한 프로젝트에서 같은 아이디어는 두 번 제안되지 않습니다. 제안된 모든 아이디어(건너뛴 것, 저장한 것, 시작한 것)는 프로젝트의 **기록**에 들어갑니다. 모델에는 그 아이디어를 다시 제안하지 말라는 지시가 전달되고, 제목이 반복된 아이디어는 버려집니다. **기록**은 아이디어를 **시작됨** 또는 **제안됨**으로 표시해 보여 줍니다. **잊기**(또는 **모두 잊기**)를 누르면 그 아이디어가 다시 나올 수 있지만, 아직 **나중에** 목록에 있는 아이디어는 그 목록에서 제거할 때까지 제안에 나오지 않습니다. 모델은 클릭할 때만 실행됩니다. | <a href="assets/features/featureIdeas.webp"><img src="assets/features/featureIdeas.webp" width="160" alt="기능 아이디어 스크린샷"></a> |
| **내용 검색** | dsh 자체 사이드바 검색(**작업 공간** 옆의 돋보기. 데스크톱 앱에서는 `Cmd+K`, 브라우저에서는 `Cmd+Alt+K`)이 제목뿐 아니라 내 메시지와 답변 속 단어로도 채팅을 찾고, 일치하는 텍스트를 채팅 아래에 보여 줍니다. 이 검색은 dsh에 이미 있지만 꺼진 상태로 제공됩니다. 이 기능은 컴퓨터에 검색 색인 파일을 두고 그 검색을 켭니다. 색인은 dsh 시작 후 첫 검색 때 만들어지며(채팅 250개에 약 15초, 제한 사항 참고) 다음 시작 때도 그대로 쓰입니다. 기본적으로 켜져 있습니다. 변경 사항은 dsh를 다시 시작한 뒤 적용됩니다. | <a href="assets/features/contentSearch.webp"><img src="assets/features/contentSearch.webp" width="160" alt="내용 검색 스크린샷"></a> |
| **턴 되돌리기** | 내 메시지 위에 포인터를 올리고 **↶** 버튼(복사 옆)을 클릭하세요. **채팅만**은 그 메시지와 이후의 모든 내용(답변, 도구 호출)을 채팅과 모델 컨텍스트에서 빼고, 메시지를 입력란에 다시 넣습니다. 메시지를 고친 뒤 다시 보내세요. **채팅과 파일**은 먼저 그 메시지 이후 바뀐 프로젝트 파일 목록을 보여 주고, 그 파일도 이전 상태로 되돌립니다. dsh 편집 도구가 바꾼 내용뿐 아니라 명령(`bash`)이 바꾼 내용도 되돌립니다. 실행 중인 턴은 먼저 멈춥니다. 채팅 로그는 다시 쓰지 않습니다. 숨겨진 표시 하나가 철회된 부분을 가립니다. dsh 자체의 `/compact`가 오래된 메시지를 가리는 방식과 같습니다. [dsh-rewind-plugin](https://www.npmjs.com/package/dsh-rewind-plugin)이 설치되어 있으면 이 일은 그 플러그인이 맡고, Composer Plus는 두 번째 버튼을 보여 주지 않습니다. | <a href="assets/features/turnRollback.webp"><img src="assets/features/turnRollback.webp" width="160" alt="턴 되돌리기 스크린샷"></a> |
| **채팅 삭제** | 사이드바 → 채팅의 **…** 메뉴(또는 마우스 오른쪽 클릭) → **삭제…** → **삭제**. dsh 자체는 보관만 할 수 있습니다. 채팅은 멈추고(dsh 자체 보관처럼 턴, 작업, 하위 에이전트, 예약도 멈춤), 저장된 기록은 하위 에이전트 채팅과 함께 macOS 휴지통으로 이동합니다(다른 시스템에서는 `$DSH_HOME/trash`). 되살리려면 폴더를 원래 위치에 다시 넣고 dsh를 다시 시작하세요. 채팅은 사이드바의 **보관된 항목만** 보기에 나타납니다. | <a href="assets/features/deleteChat.webp"><img src="assets/features/deleteChat.webp" width="160" alt="채팅 삭제 스크린샷"></a> |
| **입력창에 프로젝트 이름** | 입력란 아래 줄(턴, 토큰, 캐시 적중, 컨텍스트)이 채팅의 프로젝트 이름으로 시작합니다. 그래서 채팅이 어느 프로젝트에서 작업하는지 항상 알 수 있습니다. 이 이름은 dsh 자체의 프로젝트 제목이며, 프로젝트에 제목이 없으면 폴더 이름입니다. 포인터를 올리면 전체 폴더 경로가 보입니다. 클릭하면 사이드바에서 그 채팅을 찾아 줍니다(목록 보기와 프로젝트 보기 모두 해당). 사이드바와 프로젝트가 열리고(접힌 프로젝트와 그 **더 보기**도 열립니다), 목록이 채팅까지 스크롤되며, 채팅이 5초 동안 깜박입니다. | <a href="assets/features/projectName.webp"><img src="assets/features/projectName.webp" width="160" alt="입력창에 프로젝트 이름 스크린샷"></a> |
| **입력 기록** | 빈 입력란에서 `↑` / `↓`를 누르면 터미널처럼 보낸 메시지를 차례로 불러옵니다. | <a href="assets/features/inputHistory.webp"><img src="assets/features/inputHistory.webp" width="160" alt="입력 기록 스크린샷"></a> |
| **계획 모드 단축키** | `Shift+Tab`은 초안 맨 앞에 `/plan `을 붙입니다(다시 누르면 제거). 채팅이 이미 계획 모드이면 `Shift+Tab`으로 계획 모드를 종료합니다. | <a href="assets/features/planToggle.webp"><img src="assets/features/planToggle.webp" width="160" alt="계획 모드 단축키 스크린샷"></a> |
| **입력란 포커스 유지** | `/` 명령이나 스킬을 보낸 뒤에도 커서가 입력란에 남아 바로 다시 입력할 수 있습니다. 명령을 입력하고 `Enter`를 누르는 키보드 매크로에서도 작동합니다. dsh는 명령을 처리하는 동안 입력란을 읽기 전용으로 만들고, 그때 브라우저가 포커스를 해제합니다. 이 기능은 포커스를 입력란으로 돌려놓습니다. 단, 메뉴, 대화 상자, 다른 입력 필드에 포커스가 있으면 돌려놓지 않습니다. | <a href="assets/features/keepFocus.webp"><img src="assets/features/keepFocus.webp" width="160" alt="입력란 포커스 유지 스크린샷"></a> |
| **원클릭 계속** | 턴이 중지되거나, 실패하거나, 중간에 끊긴 뒤에는 빈 입력란에 **▶**가 표시됩니다. 한 번 클릭하면 입력란에 아무것도 쓰지 않고, 보이는 채팅 메시지도 추가하지 않은 채 기존 대화를 이어 갑니다(모델은 “멈춘 곳에서 계속하라”는 짧은 숨은 메모를 받습니다. Claude 같은 일부 제공자는 어시스턴트 답변으로 끝나는 요청을 거부하기 때문입니다). 대기열의 메시지는 그대로 남습니다. ▶는 중지된 작업만 이어 가고, 그다음에 대기열이 실행됩니다. 완료된 턴 뒤에는 일반 보내기 버튼이 그대로 있습니다. | <a href="assets/features/continueButton.webp"><img src="assets/features/continueButton.webp" width="160" alt="원클릭 계속 스크린샷"></a> |
| **재시작 후 이어서 실행** | 기본적으로 꺼져 있습니다. **설정 → Composer Plus**에서 켜세요. 채팅이 작업하는 중에 dsh를 종료하면(또는 dsh가 닫히면), dsh를 다시 열 때 그 채팅이 자동으로 이어집니다. 이때 원클릭 계속과 같은 숨은 메모를 씁니다. 목표 라운드(`/goal`)가 실행 중이었다면 목표는 다음 라운드로 계속됩니다(dsh는 시작할 때마다 목표를 일시 중지하고, 사용자가 재개할 때까지 기다립니다). 직접 중지한 채팅, 완료된 채팅, 실패한 채팅은 이어지지 않습니다. dsh 자체에는 이 설정이 없습니다. dsh는 이런 턴을 중단됨으로 표시할 뿐입니다. | <a href="assets/features/resumeAfterRestart.webp"><img src="assets/features/resumeAfterRestart.webp" width="160" alt="재시작 후 이어서 실행 스크린샷"></a> |
| **대기열 끌어서 놓기** | 대기 중인 메시지에 핸들(⠿)이 생깁니다. 끌어서 순서를 바꾸거나, 핸들에 포커스를 두고 `↑` / `↓`를 누르세요. `Esc`는 이동을 취소합니다. | <a href="assets/features/queueReorder.webp"><img src="assets/features/queueReorder.webp" width="160" alt="대기열 끌어서 놓기 스크린샷"></a> |
| **세션 링크 복사** | 사이드바에서 채팅을 마우스 오른쪽 버튼으로 클릭 → **세션 링크 복사**. `dsh-session:…` 링크를 다른 채팅에 붙여 넣으면 그 채팅이 읽기 전용 컨텍스트로 첨부됩니다. dsh 0.2.1에는 자체 **세션 ID 복사**가 있지만, 이 메뉴는 ID만 복사합니다. 이 항목은 그 바로 다음에 표시됩니다. | <a href="assets/features/copyDeeplink.webp"><img src="assets/features/copyDeeplink.webp" width="160" alt="세션 링크 복사 스크린샷"></a> |
| **채팅을 Markdown으로 내보내기** | 사이드바에서 채팅을 마우스 오른쪽 버튼으로 클릭(또는 채팅의 **…** 메뉴 열기) → **Markdown으로 내보내기…**. 대화 상자에 채팅의 메시지 수가 표시됩니다. **클립보드에 복사**는 채팅을 Markdown으로 복사하고, **.md 파일 저장**은 브라우저 다운로드로 `<chat title>.md` 파일을 저장합니다(dsh 데스크톱: 시스템 설정에 따라 다운로드 폴더에 저장되거나 저장 대화 상자가 열립니다). 파일에는 채팅 제목, 프로젝트 이름, 날짜가 들어가고, 그 뒤에 메시지마다 `## 나` 또는 `## 어시스턴트` 섹션이 하나씩 이어집니다. 코드 블록은 그대로 유지됩니다. 메시지가 닫지 않은 코드 블록은 닫힙니다. | <a href="assets/features/exportMarkdown.webp"><img src="assets/features/exportMarkdown.webp" width="160" alt="채팅을 Markdown으로 내보내기 스크린샷"></a> |
| **프로젝트 경로 복사** | 사이드바에서 프로젝트를 마우스 오른쪽 버튼으로 클릭 → **경로 복사**를 선택하면 폴더의 전체 경로가 복사됩니다. | <a href="assets/features/copyProjectPath.webp"><img src="assets/features/copyProjectPath.webp" width="160" alt="프로젝트 경로 복사 스크린샷"></a> |
| **새 채팅의 프로젝트 검색** | 새 채팅 → 입력란 위의 프로젝트 버튼. 프로젝트가 A–Z 순서로 표시되고, 맨 위에 **프로젝트 검색** 상자가 있습니다. 이름의 일부를 입력하고(대소문자와 악센트 구분 없음) `Enter`를 누르면 첫 번째로 일치하는 프로젝트가 선택됩니다. 일치하는 것이 없으면 **일치하는 프로젝트 없음**이 표시됩니다. 사이드바에 저장된 dsh의 프로젝트 순서는 바뀌지 않습니다. | <a href="assets/features/projectPicker.webp"><img src="assets/features/projectPicker.webp" width="160" alt="새 채팅의 프로젝트 검색 스크린샷"></a> |
| **다음 메시지 예측** | 기본적으로 켜져 있습니다. **설정 → Composer Plus**에서 끌 수 있습니다. 에이전트가 턴을 마치면(중지되거나 실패한 턴 제외) 빈 입력란에 다음 메시지의 예측이 회색으로 표시되고, **Tab으로 수락** 힌트가 함께 나옵니다. `Tab`을 누르면 텍스트가 입력란에 들어가지만 보내지는 않습니다. `Esc`를 누르면 그 턴 동안 예측이 숨겨집니다. 입력을 시작해도 숨겨지고, 새 턴이 오면 새 예측으로 바뀝니다. 스위치 아래의 **모델** 메뉴에는 dsh 자체의 모델 목록이 나옵니다(dsh 모델 메뉴와 같은 목록). 기본으로 **dsh 기본값**이 선택되어 있으며, dsh의 기본 모델을 따릅니다. 턴이 끝날 때마다 짧은 모델 호출이 한 번 일어납니다. Tether에서는 예측이 빈 입력란 위에 표시됩니다. 탭하면 입력란에 들어갑니다. | <a href="assets/features/nextPrediction.webp"><img src="assets/features/nextPrediction.webp" width="160" alt="다음 메시지 예측 스크린샷"></a> |
| **입력 중 자동 완성** | 기본적으로 꺼져 있습니다. **설정 → Composer Plus**에서 켤 수 있습니다. 입력하는 동안 커서 바로 뒤의 회색 텍스트가 메시지가 이어질 수 있는 내용을 보여 줍니다. `Tab`을 누르면 메시지에 추가되지만 보내지는 않습니다. `Esc`를 누르면 숨겨집니다. 회색 텍스트의 다음 글자를 그대로 입력하면 텍스트가 유지되고, 새 모델 호출은 없습니다. 스위치 아래에 이 기능 전용 **모델** 메뉴가 있습니다. 첫 항목인 **다음 메시지 예측과 같음**은 **다음 메시지 예측**의 모델을 사용합니다(기본값). 기능마다 다른 모델을 쓰려면 다른 모델을 고르세요. 예를 들어 자동 완성에는 더 빠른 모델을 고를 수 있습니다. 입력을 멈출 때마다 모델을 한 번 호출하므로 예측보다 토큰을 훨씬 많이 사용합니다. 빠르고 비용이 낮은 모델을 고르세요. 슬래시 명령, 파일 칩이 있는 메시지, 커서가 끝에 있지 않을 때는 실행되지 않습니다. Tether에서는 입력하는 동안 나머지 텍스트가 입력란 위에 표시됩니다. 탭하면 추가됩니다. | <a href="assets/features/typingCompletion.webp"><img src="assets/features/typingCompletion.webp" width="160" alt="입력 중 자동 완성 스크린샷"></a> |
| **이 채팅에서 허용** | 자동 검토가 확인을 요청하면 승인 카드에 **이 채팅에서 허용**이 추가됩니다. 이후 같은 채팅의 같은 도구는 인수와 관계없이 허용됩니다. 헤더 칩에서 허용 목록을 보고 취소할 수 있습니다. 허용은 재시작 후에도 유지됩니다. | <a href="assets/features/allowForChat.webp"><img src="assets/features/allowForChat.webp" width="160" alt="이 채팅에서 허용 스크린샷"></a> |
| **프로젝트 상태** | 사이드바의 프로젝트 행에 그 채팅과 같은 실행 중 / 대기 중 / 완료 표시가 나타납니다. 그래서 접힌 프로젝트도 안의 채팅이 작업 중인지, 사용자의 조치가 필요한지 알려 줍니다. 사용자의 조치를 기다리는 채팅이 먼저 표시되고, 그다음 아직 열지 않은 완료된 채팅(초록색 점, 다른 채팅이 아직 실행 중일 때도 표시), 마지막으로 실행 중 표시가 나타납니다. 포인터를 올리면 자세한 내용이 보입니다. | <a href="assets/features/projectStatus.webp"><img src="assets/features/projectStatus.webp" width="160" alt="프로젝트 상태 스크린샷"></a> |
| **활성 프로젝트 우선** | 채팅이 실행을 시작하거나 사용자의 조치가 필요해지면, 그 프로젝트가 dsh 자체 행 애니메이션으로 사이드바 맨 위로 이동합니다(직접 끌어 올릴 때와 같은 움직임). 완료된 프로젝트는 제자리에 남으며, 평소처럼 원하는 곳으로 끌어 옮길 수 있습니다. 이동은 dsh의 프로젝트 순서에 저장되므로, 이 기능을 꺼도 현재 순서가 유지됩니다. | <a href="assets/features/projectStatus.webp"><img src="assets/features/projectStatus.webp" width="160" alt="활성 프로젝트 우선 스크린샷"></a> |
| **최근 프로젝트 필터** | 사이드바 → 보기 옵션(슬라이더 아이콘) → **최근 2시간 내 활성**. 이 옵션을 선택하면 사이드바에는 최근 2시간 안에 활성 채팅이 있었던 프로젝트만 표시됩니다. 활성 채팅은 그 시간 안에 업데이트된 채팅, 실행 중이거나 대기 중인 채팅, 열려 있는 채팅, 아직 열지 않은 완료된 채팅(dsh의 초록색 “완료” 점)입니다. 마지막 경우는 2시간이 지나도 해당됩니다. 이런 채팅이 없는 프로젝트는 숨겨지며, 새 프로젝트와 빈 프로젝트도 숨겨집니다. 모든 프로젝트를 다시 보려면 옵션을 다시 선택하세요. 선택은 이 기기에 저장됩니다. | <a href="assets/features/recentProjects.webp"><img src="assets/features/recentProjects.webp" width="160" alt="최근 프로젝트 필터 스크린샷"></a> |
| **모든 프로젝트 접기** | 사이드바에 열린 프로젝트가 있으면 보기 옵션(슬라이더 아이콘) 옆에 버튼이 나타납니다. 클릭하면 열린 프로젝트를 한 번에 모두 닫습니다. 예를 들어 프로젝트 5개 중 열린 3개를 한 번에 닫습니다. 열린 프로젝트가 없으면 버튼이 다시 숨겨집니다. | <a href="assets/features/collapseProjects.webp"><img src="assets/features/collapseProjects.webp" width="160" alt="모든 프로젝트 접기 스크린샷"></a> |
| **상태별 정렬** | 사이드바 → 보기 옵션 → **정렬 기준** → **상태별**(**하나의 목록**과 함께 사용). 완료된 채팅이 먼저 옵니다(dsh의 “완료” 점. 오류로 끝난 턴에도 이 점이 붙습니다). 그다음 실행 중이거나 대기 중인 채팅, 활성 자동화(예약)가 있는 채팅, 나머지 채팅이 dsh 순서대로 옵니다. 완료된 채팅을 열면 아래로 이동합니다. 보기만 바뀝니다. 원래대로 돌아가려면 **수동** 또는 **마지막 업데이트**를 선택하세요. | <a href="assets/features/statusOrder.webp"><img src="assets/features/statusOrder.webp" width="160" alt="상태별 정렬 스크린샷"></a> |
| **백그라운드 알림** | dsh가 백그라운드에 있을 때 턴이 끝나면(답변의 첫 줄과 함께) 알림을 받습니다. 채팅이 정말로 사용자를 기다릴 때도 알림을 받습니다. 기다리는 이유는 승인(도구 이름), 답변(질문), 계획 검토입니다. 요청이 1.5초 뒤에도 열려 있어야 알림이 갑니다. 그래서 자동으로 처리된 승인(자동 검토 허용, 다른 플러그인)은 알림을 보내지 않습니다. 요청에 답하면 알림도 바로 사라집니다. Dock/작업 표시줄 배지는 기다리는 채팅 수를 보여 줍니다. 알림을 클릭하면 그 채팅이 열립니다. | <a href="assets/features/notifications.webp"><img src="assets/features/notifications.webp" width="160" alt="백그라운드 알림 스크린샷"></a> |
| **11개 추가 UI 언어** | 설정 → Composer Plus → **애플리케이션 언어**에서 dsh 인터페이스 전체를 Türkçe, Español, Português (Brasil), Français, Deutsch, Русский, 日本語, 한국어, Bahasa Indonesia, Tiếng Việt, हिन्दी 중 하나로 바꿉니다(아래 참고). | <a href="assets/features/language.webp"><img src="assets/features/language.webp" width="160" alt="11개 추가 UI 언어 스크린샷"></a> |
| **모바일 연결(iPhone)** | [Tether](tether/) 앱으로 iPhone에서 dsh를 사용하세요. 같은 Wi-Fi나 [Tailscale](https://tailscale.com)을 통해 연결합니다. **설정 → Composer Plus**에서 켜세요(이 Mac에서 네트워크 포트를 열기 때문에 기본적으로 꺼져 있습니다). 그다음 사이드바 왼쪽 아래의 **모바일 연결**을 클릭하세요. iPhone 카메라(**Open in Tether**를 탭)나 Tether의 **Scan code**로 QR 코드를 스캔하고, **Connect**를 탭한 뒤 **Approve**를 클릭하세요. 먼저 Tether를 설치하세요. Tether가 없으면 카메라가 이 코드를 열 수 없습니다. 휴대폰에서 채팅을 보고, 메시지를 보내고, 승인과 질문에 답하고, 모델과 에이전트를 바꿀 수 있습니다. Mac은 원하는 만큼 페어링할 수 있으며, 앱 왼쪽 위의 Mac 이름으로 Mac을 전환합니다. | <a href="assets/features/mobileConnect.webp"><img src="assets/features/mobileConnect.webp" width="160" alt="모바일 연결 스크린샷"></a> |
| **자동 업데이트** | dsh가 시작되면 플러그인이 [최신 GitHub 릴리스](https://github.com/furkancak1r/dsh-composer-plus/releases/latest)를 확인합니다. 더 새로운 버전이고 npm에도 올라와 있으면, dsh 자체 플러그인 관리자(설정 → 플러그인과 같은 경로)로 정확히 그 버전을 설치하고 알려 줍니다. 새 버전을 로드하려면 **dsh를 다시 시작**하세요. **설정 → Composer Plus → Composer Plus 업데이트**에서 버전을 볼 수 있고, **업데이트 확인** / **지금 업데이트** 버튼도 있습니다. | <a href="assets/features/autoUpdate.webp"><img src="assets/features/autoUpdate.webp" width="160" alt="자동 업데이트 스크린샷"></a> |

버튼, 툴팁, 안내 메시지, 알림은 선택한 dsh 언어를 따릅니다(아래 애플리케이션 언어 참고).

## 설정

모든 기능은 dsh **설정 → Composer Plus**에서 하나씩 켜거나 끌 수 있습니다. 각 행에는 작은 스크린샷이 있습니다. 포인터를 올리면 크게 미리 보고, 클릭하면 원래 크기로 엽니다(`Esc`로 닫기). 맨 위의 **기능 검색** 상자는 이름이나 설명으로 페이지를 걸러 냅니다(모든 언어, 대소문자와 악센트 구분 없음). `Esc`를 누르면 검색어가 지워집니다. 각 행에는 스위치와 짧은 설명이 있습니다. 변경 사항은 재시작 없이 바로 적용되고 그 기기에 저장됩니다. **모바일 연결**, **재시작 후 이어서 실행**, **입력 중 자동 완성**을 빼고 모든 기능이 기본적으로 켜져 있습니다. 이 세 기능과 **내용 검색**, **턴 되돌리기**, **다음 메시지 예측**의 스위치는 dsh의 Host가 보관합니다. 그래서 모든 창에 적용되고 재시작 후에도 유지됩니다. **다음 메시지 예측**에서 고른 **모델**과 **입력 중 자동 완성**에서 고른 모델(기본값 **다음 메시지 예측과 같음**)도 Host가 보관합니다. **내용 검색**은 dsh를 다시 시작한 뒤에만 바뀝니다(dsh가 시작할 때 이 값을 읽기 때문입니다). 그 전까지 해당 행에 **이 변경 사항을 적용하려면 dsh를 다시 시작하세요.**가 표시됩니다.

<p align="center"><img src="docs/images/settings.webp" width="720" alt="설정 → Composer Plus: 기능 검색, 언어 선택, 업데이트 행, 기능별 스위치, 포인터를 올리면 나타나는 스크린샷 미리 보기"></p>

### 애플리케이션 언어

**설정 → Composer Plus → 애플리케이션 언어**를 열고 **시스템 언어** 또는 13개 언어 중 하나를 선택하세요.

English · 中文 · Türkçe · Español · Português (Brasil) · Français · Deutsch · Русский · 日本語 · 한국어 · Bahasa Indonesia · Tiếng Việt · हिन्दी

<p align="center"><img src="docs/images/language-tr.webp" width="720" alt="Türkçe(터키어)로 바뀐 DeepSeek Harness 인터페이스"></p>

앱 전체가 바로 바뀝니다. 이 선택은 dsh 자체에 저장되는 `locale.preference`(일반 → 언어와 같은 설정)이므로 재시작 후에도 유지됩니다. **시스템 언어**는 이 선택을 지웁니다. 그러면 데스크톱 앱은 OS 언어를, 웹 UI는 브라우저 언어를 따릅니다. 지원하지 않는 언어이면 영어로 표시됩니다. 플러그인을 설치해도 이미 고른 언어는 절대 바뀌지 않습니다.

각 언어 팩에는 텍스트 3,143개가 있습니다. dsh `0.2.0-rc.2`와 `0.2.1-rc.2`의 모든 UI 텍스트(채팅, 사이드바, 설정, 승인, 예약, 파일 미리 보기, 플러그인 관리자, 플러그인 마켓), 플러그인 자체의 컨트롤, 인기 있는 [dsh-rewind](https://github.com/SiriLee/dsh-rewind) 플러그인의 텍스트가 포함됩니다. 번역하지 않는 것: 내 메시지, 모델 출력, 코드, 슬래시 명령 이름(`/plan`, `/compact`), `High` 추론 강도처럼 제공자가 정한 레이블, 다른 플러그인의 텍스트, 데스크톱 앱의 네이티브 메뉴와 업데이트 대화 상자(dsh가 영어/중국어로만 제공). 더 새로운 dsh가 추가한 문자열은 팩이 업데이트될 때까지 영어로 표시됩니다. 다른 플러그인이 이미 어떤 언어를 제공하면, 그 언어는 해당 플러그인의 것이 유지됩니다.

## 키보드 단축키

| 키 | 위치 | 동작 |
|---|---|---|
| `↑` / `↓` | 빈 입력란 | 이전 / 다음 보낸 메시지 |
| `Shift+Tab` | 입력란 | `/plan ` 추가/제거 또는 계획 모드 종료 |
| `↑` / `↓` | 포커스된 대기열 핸들 | 대기 중인 메시지 이동 |
| `Esc` | 드래그하는 중 | 이동 취소 |
| `→` / `←` | 기능 아이디어 페이지 | 맨 위 카드 구현 / 건너뛰기 |
| `↓` | 기능 아이디어 페이지 | 맨 위 카드를 프로젝트의 나중에 목록에 저장 |
| `↑` | 기능 아이디어 페이지 | 맨 위 카드를 계획 없이 바로 구현 |
| `Z` | 기능 아이디어 페이지 | 마지막으로 건너뛴 카드 되돌리기 |
| `Enter` | 새 채팅의 프로젝트 메뉴, 검색 상자 | 첫 번째로 일치하는 프로젝트 선택 |
| `↑` / `↓` | 새 채팅의 프로젝트 메뉴 | 표시된 프로젝트 사이를 이동 |
| `Esc` | 새 채팅의 프로젝트 메뉴, 검색 상자 | 검색어 지우기(다시 누르면 메뉴 닫기) |
| `Tab` | 예측이 표시된 빈 입력란 | 예측을 입력란에 넣기 |
| `Tab` | 커서 뒤의 회색 완성 텍스트 | 완성 텍스트를 메시지에 추가하기 |
| `Esc` | 예측이 표시된 빈 입력란 | 예측 숨기기 |

`/` 또는 `@` 메뉴가 열려 있으면 이 키는 메뉴가 사용합니다.

## 호환성

dsh `0.2.0-rc.2`(데스크톱과 웹)와 `0.2.1-rc.2`(웹)에서 테스트했습니다. CI는 푸시할 때마다 테스트를 실행합니다.

## 개인정보 보호와 보안

- **계속:** 인증된 로컬 엔드포인트는 마지막으로 중단된 턴만 재개합니다. 오래되었거나 중복된 요청은 거부하고, 기존 승인 훅은 그대로 유지합니다. 새 사용자 메시지는 보내지 않습니다.
- **재시작 후 이어서 실행:** 켜기 전까지 꺼져 있습니다. Host 쪽은 채팅 ID와 시작 시각만 `$DSH_HOME/storages/dsh-composer-plus/resume.json`(소유자 전용 권한)에 보관합니다. 아무것도 컴퓨터 밖으로 나가지 않습니다. 마지막 턴을 사용자가 아니라 dsh가 멈췄다고 dsh 자체 로그에 기록된 경우에만 채팅을 이어 갑니다. 이어지는 턴에도 승인과 자동 검토가 평소대로 적용됩니다.

- **변경 사항 패널:** git은 dsh의 인증된 `/api` 채널을 거쳐, 내 컴퓨터의 채팅 폴더 안에서 읽기 전용으로 실행됩니다. 커밋, 스테이징, fetch는 절대 하지 않으며, git 자체가 나열한 경로만 보여 줍니다.
- **기능 아이디어:** **기능 제안**을 클릭하기 전에는 아무것도 실행되지 않습니다. 클릭하면 Host 쪽이 채팅 자체의 폴더만 읽습니다(브라우저는 경로를 보내지 않습니다). 읽는 내용은 최상위 항목 이름, README·AGENTS.md·매니페스트(`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, …)의 처음 6 kB, `git log --oneline -15`이며, 합계 최대 16 kB입니다. `.env*`, 키 파일, `node_modules` 같은 폴더는 건너뜁니다. 폴더 안에 있는 일반 파일만 읽으며, 폴더 밖을 가리키는 심볼릭 링크, FIFO, 장치는 건너뜁니다. 이 요약은 dsh 자체 제공자 설정을 거쳐 채팅이 쓰는 모델에 요청 한 번으로 전달됩니다. 어떤 채팅에도 추가되지 않습니다. 프로젝트에는 아무것도 쓰지 않습니다. 오른쪽으로 스와이프한 아이디어는 계획 모드로 새 채팅을 시작하므로, 승인과 계획 검토가 평소대로 적용됩니다. **바로 구현**은 계획 모드 없이 채팅을 시작합니다. 모델이 바로 파일을 바꿀 수 있으며, 채팅의 평소 승인과 자동 검토가 적용됩니다. 나중을 위해 저장한 아이디어(제목, 요약, 이유, 작업량)는 프로젝트 폴더 경로와 함께 dsh 홈 아래 `storages/dsh-composer-plus/later.json`(소유자 전용 파일)에 보관됩니다. 프로젝트에는 아무것도 들어가지 않습니다. 제안된 아이디어의 기록(제목, 요약, 이유, 작업량, 날짜, 시작 여부)도 같은 방식으로 `storages/dsh-composer-plus/idea-history.json`에 보관되며, 프로젝트당 최대 200개입니다(가장 오래된 것부터 지워집니다). 그 제목들은 그 프로젝트에서 다음에 **기능 제안**을 누를 때 모델에 전달됩니다.
- **내용 검색:** 채팅을 검색하는 새 코드는 없습니다. 플러그인은 dsh 자체 메시지 색인(SQLite FTS5, `dsh-session-query-sqlite`)을 켜고, 그 색인에 `$DSH_HOME/cache/composer-plus/session-search.db` 파일(소유자 전용 파일과 폴더)을 지정할 뿐입니다. 이 파일에는 사용자와 어시스턴트 메시지의 텍스트가 들어 있으므로, `$DSH_HOME/sessions`의 채팅 로그만큼 민감합니다. 아무것도 컴퓨터 밖으로 나가지 않습니다. 이 파일은 dsh가 다시 만들 수 있는 사본이므로, dsh가 닫혀 있을 때 삭제해도 됩니다. 스위치 값은 `$DSH_HOME/storages/dsh-composer-plus/content-search.json`에 있습니다.
- **턴 되돌리기:** 내 메시지마다, 보내기 전에 Host가 채팅 폴더의 git 스냅샷을 자체 저장소 `$DSH_HOME/cache/composer-plus/rollback/<chat>.git`(소유자 전용 폴더)에 만듭니다. 이 저장소에는 그 폴더에서 git이 보는 파일(무시된 파일 제외)의 사본이 있으므로, 프로젝트만큼 민감합니다. 내 저장소의 객체를 읽기만 하고(git에 이미 있는 것은 복사하지 않음), 내 저장소의 인덱스, `HEAD`, 브랜치, 태그, stash, 설정에는 절대 쓰지 않습니다. git이 그곳에서 바꾸는 것은 재사용한 객체 파일의 타임스탬프를 새로 고치는 것뿐입니다(그래서 `git gc`의 정리가 늦어집니다). 파일까지 되돌릴 때는 채팅 폴더 안의 일반 파일에만 씁니다. 심볼릭 링크, 파이프, 폴더 밖의 모든 것은 건너뜁니다. 아무것도 컴퓨터 밖으로 나가지 않습니다. dsh가 닫혀 있을 때 이 저장소를 삭제해도 됩니다(그러면 새 메시지를 보낼 때까지 채팅만 되돌릴 수 있습니다). **채팅 삭제**는 채팅의 저장소도 함께 삭제합니다. 스위치 값은 `$DSH_HOME/storages/dsh-composer-plus/rollback.json`에 있습니다.
- **채팅을 Markdown으로 내보내기:** 호스트 쪽은 채팅 자체의 로그(dsh가 보여 주는 것과 같은 메시지)만 읽어 페이지에 넘깁니다. 프로젝트 파일은 읽지 않고, 네트워크로 아무것도 보내지 않습니다. Markdown은 클립보드나 사용자가 저장하는 파일로만 갑니다.
- **채팅 삭제:** 채팅 자체의 로그 폴더(`$DSH_HOME/sessions/<project>/<chat>`)를 휴지통으로 옮깁니다. 프로젝트 폴더는 건드리지 않습니다.
- **이 채팅에서 허용:** 허용 항목은 `$DSH_HOME/storages/dsh-composer-plus/grants.json`(소유자 전용 권한)에 저장됩니다. 허용 하나는 **한 채팅의 정확히 한 도구**에만 적용됩니다. 그 도구가 쓰기를 할 수 있다면, 허용은 모든 쓰기에도 적용됩니다. 헤더 칩에서 취소하세요.
- 자동 검토는 여전히 모든 호출에서 실행됩니다. 검토가 실패한 호출은 절대 자동으로 허용되지 않습니다.
- **모바일 연결:** 켜기 전까지 꺼져 있습니다. 켜져 있는 동안 Host 쪽이 Tether 게이트웨이를 실행합니다. 게이트웨이는 두 부분입니다. 포트 19390의 HTTPS는 Wi-Fi 서브넷과 tailnet(100.64.0.0/10)의 연결만 받고, `127.0.0.1:19391`의 페어링 페이지는 이 Mac에서만 열립니다. 휴대폰을 연결하려면 QR 코드의 일회용 코드(5분 유효)와 Mac에서의 **Approve**가 필요합니다. 휴대폰은 게이트웨이 인증서를 고정(pinning)합니다. Mac은 각 휴대폰 토큰의 해시만 보관합니다(30일, 사용하는 동안 갱신). **Revoke**를 누르면 그 휴대폰의 연결이 즉시 끊깁니다. 휴대폰은 허용 목록에 있는 dsh 메서드(채팅, 프롬프트, 첨부 파일, 슬래시 명령, 승인, 질문, 모델, 에이전트, 목표)만 호출할 수 있습니다. 설정, 자격 증명, 파일 브라우저, 터미널은 호출할 수 없습니다. 데이터: `$DSH_HOME/storages/dsh-composer-plus/mobile/`. 자세한 내용: [tether/README.md](tether/README.md).
- **업데이트:** Host 쪽은 `api.github.com`에 최신 릴리스를 묻고, `registry.npmjs.org`에 그 정확한 버전을 묻습니다. 사용자나 채팅에 관한 정보는 보내지 않습니다. 설치는 dsh의 플러그인 관리자(`pnpm add dsh-composer-plus@<version>`. 이미 설치된 플러그인에 대해 dsh 0.2.1이 이를 거부하면 `pnpm add https://registry.npmjs.org/dsh-composer-plus/-/dsh-composer-plus-<version>.tgz`를 쓰며, 그 후 프로필에는 그 URL이 플러그인의 소스로 표시됩니다)를 쓰므로, dsh 자체의 레지스트리, 스크립트, 버전 호환성 검사가 적용됩니다. 사전 릴리스 태그와 더 오래된 버전은 절대 설치하지 않습니다.
- **다음 메시지 예측:** 기본적으로 켜져 있습니다. 이 모델 호출을 막으려면 **설정 → Composer Plus**에서 끄세요. 턴이 끝날 때마다 Host 쪽은 그 채팅에서 사용자가 직접 보낸 메시지와 에이전트의 텍스트 답변(도구 출력, 숨은 컨텍스트, 추론 제외)을 최대 약 6,000자(가장 최근 부분)까지 고른 모델(다른 모델을 고르지 않으면 dsh의 기본 모델)에 보냅니다. dsh 자체 제공자 설정을 거쳐 요청 한 번으로 전달됩니다. 채팅에는 아무것도 저장되지 않으며, 예측은 채팅 기록에 추가되지 않습니다. 스위치와 고른 모델은 `$DSH_HOME/storages/dsh-composer-plus/predict.json`(소유자 전용 파일)에 보관됩니다.
- **입력 중 자동 완성:** 켜기 전까지 꺼져 있습니다. 켜져 있는 동안 입력을 멈출 때마다 Host 쪽은 지금까지 입력한 텍스트와, 그 채팅에서 사용자가 직접 보낸 메시지와 에이전트의 텍스트 답변(도구 출력, 숨은 컨텍스트, 추론 제외)을 채팅 기준 최대 약 3,000자까지 **입력 중 자동 완성**에서 고른 모델(기본값: **다음 메시지 예측**의 모델)에 보냅니다. 입력을 다시 멈추면 이전 요청은 중지됩니다. 채팅에는 아무것도 저장되지 않습니다. 스위치는 `$DSH_HOME/storages/dsh-composer-plus/complete.json`(소유자 전용 파일)에 보관됩니다.

## 문제 해결

- **macOS에서 알림이 오지 않음:** 시스템 설정 → 알림 → DeepSeek Harness → 알림을 허용하세요. 알림을 화면에 계속 두려면 알림 스타일에서 **알림**을 선택하세요.
- **dsh 업데이트 후 ▶, 대기열 핸들, 프로젝트 상태, 최근 프로젝트 옵션, 모든 프로젝트 접기, 경로 복사, 프로젝트 검색 상자, 다음 메시지 예측, 입력 중 자동 완성, 이 채팅에서 허용 또는 오른쪽 클릭 메뉴가 보이지 않음:** 이 요소들은 dsh에 아직 전용 슬롯이 없어서 dsh의 현재 HTML에 붙습니다. dsh가 그 마크업을 바꾸면 이 요소들은 스스로 숨겨지며, 다른 기능은 망가지지 않습니다. [issue](https://github.com/furkancak1r/dsh-composer-plus/issues)를 열어 주세요.
- **"업데이트 실패" 또는 "npm에서 설치되지 않았으므로" 메시지:** 로컬 폴더에서 링크했거나 이름을 바꾼 사본은 스스로 업데이트할 수 없습니다. 설정 → 플러그인에서 `dsh-composer-plus`를 다시 설치하세요. 그 밖의 경우에는 메시지에 pnpm 오류의 첫 줄이 표시됩니다. **업데이트 확인**을 누르면 다시 시도합니다.
- **모바일 연결에 게이트웨이가 실행되고 있지 않다고 표시됨:** "no IPv4 address on en0"은 이 Mac에 Wi-Fi/이더넷 주소가 없다는 뜻입니다. "EADDRINUSE"는 다른 dsh(또는 앱)가 포트 19390 또는 19391을 쓰고 있다는 뜻입니다. 모바일 연결은 한 번에 dsh 하나에서만 실행할 수 있습니다.
- **모바일 연결, 재시작 후 이어서 실행, 내용 검색에 "dsh를 다시 시작하세요"가 표시됨:** dsh가 실행 중일 때 플러그인이 업데이트되었습니다(내용 검색은 스위치를 바꾼 경우에도 표시됩니다). 새 상태는 재시작 후 로드됩니다.
- **검색이 제목만 찾음:** 내용 검색이 꺼져 있거나, 켜거나 플러그인을 설치한 뒤 dsh를 다시 시작하지 않았거나, 그 단어가 도구 출력에만 있습니다(제한 사항 참고).
- **내 메시지에 ↶ 버튼이 없음:** 턴 되돌리기가 꺼져 있거나, 하위 에이전트 채팅이거나, dsh-rewind-plugin이 설치되어 있습니다(그 플러그인의 ↶ 버튼을 쓰세요). 업데이트한 뒤에는 dsh를 다시 시작하세요.
- **채팅과 파일이 회색으로 비활성화됨:** 프로젝트가 git 저장소가 아니거나, 그 메시지 이전 스냅샷이 없거나(메시지가 플러그인보다 오래되었거나, 최신 스냅샷 50개가 그 스냅샷을 대체함), 바뀐 파일이 없습니다.
- **삭제할 때 다른 dsh가 이 채팅을 열고 있다고 표시됨:** 같은 dsh 홈을 쓰는 두 번째 dsh가 채팅 잠금을 잡고 있습니다. 그 창이나 dsh를 닫은 뒤 다시 삭제하세요. 그동안 채팅은 보관된 상태로 남습니다.
- **재시작 후 채팅이 이어지지 않음:** dsh를 종료할 때 재시작 후 이어서 실행이 꺼져 있었거나, 그 턴을 직접 중지했거나, 턴이 이미 끝났거나(완료 또는 실패), 채팅이 보관되었거나, 실행 중인 채팅이 20개보다 많았습니다(가장 최근 채팅 20개만 이어짐).
- **릴리스 직후 설치 실패:** 버전을 붙여서 설치하세요(`dsh-composer-plus@1.11.0`). 위의 설치 안내를 참고하세요.

## 제한 사항

- 메시지 없는 계속은 dsh의 `agent/pre-step` → `agent/request` 수명 주기에 의존합니다. dsh를 업그레이드할 때 호환성을 다시 확인하세요.
- **기능 아이디어**는 dsh나 페이지를 다시 로드할 때까지 채팅마다 카드를 메모리에 둡니다. 그 뒤 **기능 제안**은 모델에 다시 묻습니다. 카드는 클릭한 시점의 dsh UI 언어로 나옵니다. 언어를 바꿔도 이미 쌓인 카드는 원래 언어를 유지하고, **아이디어 더 받기**는 새 언어를 씁니다. 모델은 코드가 아니라 짧은 프로젝트 요약만 봅니다. 그래서 프로젝트에 이미 있는 기능을 제안할 수도 있습니다. 그럴 때는 건너뛰세요. 새 채팅은 프로필에 dsh의 `/plan` 명령이 있을 때만 계획 모드로 실행됩니다. 없으면 아이디어가 일반 첫 메시지로 전달됩니다. **나중에** 목록은 채팅의 폴더 경로에 속합니다. 같은 폴더를 심볼릭 링크로 열면 별도 목록이 생깁니다. 프로젝트당 최대 50개 아이디어를 보관하며(더 추가하려면 하나를 제거하세요), 같은 제목은 한 번만 보관합니다. 카드를 끌면 왼쪽 또는 오른쪽만 결정됩니다. 저장하려면 **↓**를, 바로 구현하려면 **▶**를 쓰세요. 반복은 제목으로만 찾습니다. 그래서 모델이 이전 아이디어를 새 이름으로 다시 제안할 수 있습니다. 그럴 때는 건너뛰세요. 모델이 이전 아이디어만 답하면 새로 보이는 것이 없습니다. 다시 클릭하세요. 집중 주제가 좁으면 이런 일이 더 자주 생깁니다. 더 넓은 주제를 쓰거나 주제를 지우세요. 집중 주제는 dsh나 페이지를 다시 로드할 때까지 채팅마다 입력란에 남아 있습니다.
- **채팅을 Markdown으로 내보내기**에는 사용자 자신의 메시지와 어시스턴트의 텍스트 답변만 들어갑니다. 도구 호출과 그 출력, 생각, 이미지(`[image]` 줄로 표시됩니다), 숨겨진 컨텍스트, 턴 되돌리기나 dsh-rewind-plugin로 뺀 메시지는 빠집니다. 한 턴의 답변은 섹션 하나로 합쳐집니다. 내보내기 한 번에는 최대 약 400만 자가 들어갑니다. 더 긴 채팅은 앞부분과 안내 문구만 내보냅니다.
- **재시작 후 이어서 실행**은 턴을 이어 갈 뿐, 처음부터 다시 실행하지 않습니다. 종료 시점에 실행 중이던 도구 호출은 dsh의 “결과 알 수 없음” 결과로 끝납니다. 모델에게는 끝난 작업을 반복하지 말라고 알리지만, 두 번 실행하면 안전하지 않은 명령이 다시 실행될 수 있습니다. 열려 있던 하위 에이전트, 승인, 질문은 복원되지 않습니다. 대신 부모 채팅이 이어지면서 다시 묻습니다. 한 번 시작할 때 최대 20개 채팅만 이어집니다.

- **내용 검색**은 dsh 자체 검색이므로 dsh의 제한을 그대로 가집니다. 사용자와 어시스턴트 메시지만 검색합니다. 도구 출력(명령, 파일 내용, 결과)과 추론은 검색하지 않으며, 사용자, 어시스턴트, 도구 메시지를 고르는 필터도 없습니다. 단어 일부가 아니라 단어 전체가 일치해야 합니다(`deploy`로는 `deployment`를 찾을 수 없음). 악센트가 있는 글자는 악센트 없이도 일치합니다(`seker`로 `şeker`를 찾음). 채팅마다 한 행에 dsh의 240자 발췌가 표시되며, 최대 20행입니다.
- **내용 검색**의 비용은 실제 채팅 로그 247개의 사본으로 측정했습니다(159 MB, dsh 0.2.1-rc.2, Apple Silicon, 32 GB). 시작 후 첫 검색에서 약 15초 동안 색인을 만듭니다. 그중 약 7초 동안 dsh의 Host가 아무 응답도 하지 않으므로, 다른 채팅의 스트리밍이 그 순간 멈춥니다(페이지 자체는 멈추지 않습니다). Host의 메모리는 최고 약 1.1 GB 늘어납니다. 1분 뒤에도 시작 때보다 약 0.5–0.6 GB 많은 상태가 dsh를 종료할 때까지 유지됩니다. 색인 파일은 약 165 MB입니다. 이후 검색은 약 0.5초 걸립니다. 재시작 후 첫 검색은 약 1초 걸리고(새 채팅이나 바뀐 채팅만 추가) 메모리가 약 70 MB 늘어납니다. 컴퓨터 메모리가 적다면 이 기능을 끄세요.
- **내용 검색**은 dsh를 다시 시작한 뒤에만 적용됩니다. 같은 dsh 홈을 쓰는 모든 dsh가 색인 파일을 함께 쓰므로, 이런 dsh는 한 번에 하나만 실행하세요(dsh는 색인 파일 하나에 소유자 하나만 허용합니다).
- **턴 되돌리기**는 git 저장소에서만, 그리고 채팅 폴더 안에서만 파일을 되돌립니다. 채팅마다 최신 스냅샷 50개를 보관합니다. 무시된 파일(`.gitignore`, `info/exclude`, 전역 ignore 파일), 빈 폴더, 심볼릭 링크, 서브모듈은 되돌리지 않습니다. 스냅샷을 만들 때 무시되던 파일은 턴이 ignore 규칙을 바꾸었더라도 절대 삭제하지 않습니다. git이 읽을 수 없는 파일은 스냅샷에서 빠집니다. 메시지를 보낼 때마다 채팅 폴더에 `git add --all`을 한 번 실행해 비공개 저장소에 넣습니다. 추적되지 않는 파일이 많은 아주 큰 폴더에서는 몇 초 걸릴 수 있고, 다음 도구 호출이 이를 기다립니다(최대 10초. 그 뒤 스냅샷은 백그라운드에서 마무리됩니다). 내 저장소의 `git gc`가 오래된 스냅샷에 필요한 객체를 지우면, 그 파일은 되돌리지 못한 파일로 표시됩니다. 입력란에는 메시지의 텍스트만 돌아옵니다. 이미지나 파일은 다시 추가하세요. 하위 에이전트 채팅에는 ↶가 없습니다(하위 에이전트의 파일 변경은 그 하위 에이전트를 시작한 채팅의 변경으로 칩니다). 내보낸 채팅(`/export`)에는 철회한 메시지가 그대로 남아 있습니다. 숨겨진 표시 하나로 채팅 일부를 철회하는 아이디어는 SiriLee의 [dsh-rewind-plugin](https://github.com/SiriLee/dsh-rewind)(MIT)에서 가져왔습니다. Composer Plus는 그 코드를 전혀 쓰지 않습니다.
- **채팅 삭제**에는 dsh의 보관 기능(dsh 0.2.0 이상)이 필요합니다. 15초 안에 멈추지 않거나 다른 dsh가 잡고 있는 채팅(또는 그 하위 에이전트 채팅 중 하나)은 보관된 상태로 남고, 아무것도 이동하지 않습니다. macOS가 아닌 시스템에서는 휴지통 폴더가 채팅 기록과 같은 디스크에 있어야 합니다. 열려 있는 채팅을 삭제하면, 그 채팅은 dsh를 다시 시작할 때까지 dsh 메모리에 보관되고 숨겨진 상태로 남습니다. 휴지통은 직접 비우세요. dsh는 휴지통을 비우지 않습니다.
- dsh의 대기열에는 `move` 동작이 없습니다. 그래서 플러그인의 Host 쪽이 dsh의 대기열 안에서 대기 중인 메시지 자체를 옮깁니다(한 번의 변경, 같은 메시지). 이미지나 파일이 있는 메시지도 이동할 수 있습니다. 내 메시지만 이동할 수 있습니다. 대기열에 있는 목표 라운드나 질문에 대한 답변은 제자리에 남습니다. 끄는 중에 메시지 전송이 시작되면 아무것도 이동하지 않고, 알림으로 이를 알려 줍니다.
- 새 버전이 dsh 설정을 하나도 바꾸지 않으면 dsh 0.2.1은 업데이트를 바로 로드합니다. 그 밖의 경우와 dsh 0.2.0에서는 업데이트를 로드하려면 dsh를 다시 시작하세요. 플러그인은 dsh를 대신 재시작하지 않습니다. dsh 플러그인 관리자가 없는 웹/CLI 프로필은 새 버전을 알리기만 합니다.
- **입력란 포커스 유지**는 `/` 명령이나 스킬을 보낸 뒤에만 포커스를 돌려줍니다. dsh가 명령을 처리하는 몇 밀리초 동안 입력란이 읽기 전용이므로, 그동안 누른 키는 사라집니다. dsh의 `/` 메뉴가 아직 열려 있으면 `Enter`는 강조된 행을 선택하고 메시지를 보내지 않습니다.
- **모바일 연결**은 macOS에서만 작동합니다(`en0`, `openssl`, `swift`, `dns-sd` 사용). 고정 포트 19390과 19391을 쓰므로, Mac마다 한 번에 dsh 하나에서만 실행할 수 있습니다(각 Mac은 휴대폰의 Mac 목록에서 항목 하나입니다). 휴대폰은 Tether가 열려 있거나 막 백그라운드로 간 동안에만 알림을 받습니다(푸시 서비스 없음). iOS 앱은 아직 App Store에 없습니다. Xcode로 `tether/ios`에서 빌드하세요.
- 세션 링크는 채팅 안에서 작동하지만, 클릭해도 채팅이 열리지는 않습니다.
- 재시작 전에 보낸 알림을 클릭하면 dsh를 앞으로 가져오기만 합니다.
- 활성 프로젝트는 dsh에 저장되는 프로젝트 순서로 이동하므로, 새 순서는 재시작 후에도 유지됩니다. 어느 프로젝트에도 속하지 않은 채팅("그룹 없음")은 이동할 수 없습니다. dsh는 이 채팅을 항상 맨 마지막에 나열합니다.
- dsh의 사이드바 보기 옵션 메뉴에는 확장 지점이 없습니다. 그래서 최근 프로젝트 옵션은 dsh 자체 메뉴에 추가됩니다. dsh 업데이트로 이 메뉴가 바뀌면 옵션이 표시되지 않고 모든 프로젝트가 계속 보입니다. 필터는 프로젝트 행에 적용되므로 **하나의 목록**은 걸러지지 않습니다. **작업 공간**과 함께 쓰세요. **작업 공간 트리**에서는 숨겨진 상위 폴더가 그 안의 활성 프로젝트도 숨깁니다. **상태별**에도 같은 종류의 제한이 있습니다. dsh에는 정렬 슬롯이 없으므로, 항목과 행 순서가 dsh의 메뉴와 목록 마크업에 붙습니다.
- dsh에는 프로젝트 행 메뉴나 작업 공간 헤더 슬롯도 없습니다. **경로 복사**는 dsh의 행 마크업으로 프로젝트 행을 찾습니다. **모든 프로젝트 접기**는 dsh 헤더에 들어가서, 프로젝트 행을 클릭하는 것과 같은 방식으로 열린 프로젝트를 하나씩 닫습니다. dsh 업데이트로 이 마크업이 바뀌면 오른쪽 클릭 시 브라우저 메뉴가 나오고 버튼은 표시되지 않습니다.
- dsh에는 새 채팅의 프로젝트 메뉴에도 확장 지점이 없습니다. 그래서 **프로젝트 검색** 상자와 A–Z 순서는 dsh의 메뉴 마크업에 붙습니다. dsh 업데이트로 이 마크업이 바뀌면 메뉴는 dsh가 그리는 그대로 표시됩니다. 즉, 저장된 순서로 표시되고 검색 상자는 없습니다. A–Z 순서는 보기일 뿐이며, dsh에 저장된 프로젝트 순서를 바꾸지 않습니다.
- dsh에는 입력란 힌트를 위한 확장 지점도 없습니다. 그래서 **다음 메시지 예측** 텍스트는 dsh 자체의 플레이스홀더(`[data-composer-placeholder]`) 위에 겹쳐 표시됩니다. dsh 업데이트로 이 마크업이 바뀌면 예측이 표시되지 않습니다. 켜져 있는 동안에는 턴이 끝날 때마다 짧은 모델 호출이 한 번 일어납니다.
- **입력 중 자동 완성**은 dsh 자체의 입력란 힌트(dsh가 슬래시 명령의 인수 힌트에 쓰는 `--dsh-composer-hint` 스타일)로 텍스트를 표시합니다. 슬래시 명령, 파일 칩이나 기호 칩이 있는 메시지, 커서가 메시지 끝에 있지 않을 때는 실행되지 않습니다. dsh 업데이트로 이 스타일이 바뀌면 완성 텍스트가 표시되지 않습니다. 입력을 멈출 때마다 모델 호출이 한 번 일어납니다.
- 기본 지원은 업스트림에 요청해 두었습니다: 대기열 `move`는 [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773), 계속 상태는 [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269).

## 자주 묻는 질문

**DeepSeek Harness에 변경 사항 / git diff 패널을 추가하려면 어떻게 하나요?** `dsh-composer-plus`를 설치한 뒤 오른쪽 사이드바 → `+` → **변경 사항**을 여세요.

**dsh가 Tinder 카드를 넘기듯 내 프로젝트에 맞는 기능을 제안할 수 있나요?** 네. 오른쪽 사이드바 → `+` → **기능 아이디어** → **기능 제안**. 오른쪽으로 스와이프하면 그 기능을 계획하는 새 채팅이 시작되고, **▶ 바로 구현**을 클릭하면 계획 없이 그 기능을 바로 구현하는 채팅이 시작되며, 왼쪽으로 스와이프하면 건너뜁니다.

**dsh 사이드바 검색이 제목뿐 아니라 메시지 속 단어로도 채팅을 찾을 수 있나요?** 네, **내용 검색**(기본적으로 켜짐)으로 가능합니다. 플러그인을 설치한 뒤 dsh를 한 번 다시 시작하고, **작업 공간** 옆의 돋보기를 쓰세요. 일치하는 채팅에는 그 단어 주변의 텍스트가 표시됩니다.

**OpenCode나 Claude Code처럼 턴을 되돌리고 프롬프트를 고칠 수 있나요?** 네, **턴 되돌리기**로 가능합니다. 메시지의 **↶** 버튼을 클릭하고 **채팅과 파일**을 선택하세요. 그다음 입력란에 돌아온 텍스트를 고쳐서 보내세요.

**채팅을 보관하는 대신 삭제할 수 있나요?** 네, **채팅 삭제**로 가능합니다: **…** → **삭제…**. 기록은 휴지통으로 가므로 실수해도 되돌릴 수 있습니다.

**채팅이 어느 프로젝트에 속하는지 어떻게 알 수 있나요?** 입력란 아래 줄을 보세요. **입력창에 프로젝트 이름**(기본적으로 켜짐)이 켜져 있으면 그 줄이 프로젝트 이름으로 시작합니다. 포인터를 올리면 폴더 경로가 보입니다.

**dsh 입력란에서 ↑/↓ 메시지 기록을 쓰려면 어떻게 하나요?** 이 플러그인을 설치하세요. 빈 입력란에서 `↑` / `↓`로 보낸 메시지를 차례로 불러옵니다.

**"continue"를 입력하지 않고 중지되거나 실패한 dsh 턴을 이어 가려면 어떻게 하나요?** 이 플러그인을 쓰면 턴이 중지되거나, 실패하거나, 중간에 끊긴 뒤 보내기 버튼이 **▶**로 바뀝니다. 한 번 클릭하면 턴이 이어집니다.

**dsh를 종료했다가 다시 열면 실행 중이던 채팅이 이어지나요?** 저절로 이어지지는 않습니다. dsh는 이런 턴을 중단됨으로 표시하고 기다립니다(목표도 `/goal resume`을 기다립니다). **설정 → Composer Plus → 재시작 후 이어서 실행**을 켜세요. 그러면 dsh를 종료할 때 작업 중이던 채팅이 다음 시작 때 자동으로 이어집니다.

**예측은 어떤 모델이 쓰나요?** **설정 → Composer Plus → 다음 메시지 예측 → 모델**에서 고른 모델입니다. 이 목록은 dsh 자체의 모델 목록입니다. **dsh 기본값**은 dsh의 기본 모델을 따릅니다. dsh 목록에서 고른 모델이 사라지면 예측은 기본 모델을 씁니다. **입력 중 자동 완성**에는 전용 **모델** 메뉴가 있습니다. **다음 메시지 예측과 같음**(기본값)은 예측의 모델을 따르고, 다른 모델을 고르면 그 모델은 자동 완성에만 사용됩니다. dsh 목록에서 그 모델이 사라지면 자동 완성은 예측의 모델을 씁니다.

**dsh에서 대기 중인 메시지의 순서를 바꾸려면 어떻게 하나요?** 대기 중인 메시지의 ⠿ 핸들을 끌거나, 핸들에 포커스를 두고 `↑` / `↓`를 누르세요.

**한 채팅에서 자동 검토가 같은 도구를 계속 묻지 않게 하려면 어떻게 하나요?** 승인 카드에서 **이 채팅에서 허용**을 클릭하세요. 이 허용은 그 채팅의 그 도구에만 적용됩니다. 헤더 칩에서 취소할 수 있습니다.

**dsh 사이드바에 오늘 사용한 프로젝트만 표시하려면 어떻게 하나요?** 사이드바 → 보기 옵션(슬라이더 아이콘) → **최근 2시간 내 활성**. 모든 프로젝트를 다시 보려면 이 옵션을 다시 선택하세요.

**dsh에서 프로젝트 폴더 경로를 복사하려면 어떻게 하나요?** 사이드바에서 프로젝트를 마우스 오른쪽 버튼으로 클릭 → **경로 복사**.

**dsh 사이드바의 모든 프로젝트를 한 번에 접으려면 어떻게 하나요?** 보기 옵션(슬라이더 아이콘) 옆의 접기 버튼을 클릭하세요. 이 버튼은 열린 프로젝트가 하나 이상 있을 때 표시됩니다.

**dsh 작업이 끝나거나 승인이 필요할 때 macOS / Windows 알림을 받으려면 어떻게 하나요?** **백그라운드 알림**을 켜 두세요(기본값). 그리고 OS 설정에서 DeepSeek Harness의 알림을 허용하세요.

**DeepSeek Harness 인터페이스를 터키어, 스페인어, 일본어 등으로 바꾸려면 어떻게 하나요?** 설정 → Composer Plus → **애플리케이션 언어**.

**iPhone에서 dsh를 쓰려면 어떻게 하나요?** `tether/ios`에서 Tether 앱을 빌드하세요(Xcode). **설정 → Composer Plus → 모바일 연결(iPhone)**을 켜고, 왼쪽 아래의 **모바일 연결**을 클릭하세요. QR 코드를 스캔하고(iPhone 카메라 또는 Tether의 **Scan code**), **Connect**를 탭한 뒤 **Approve**를 클릭하세요. 집 밖에서는 두 기기 모두에서 Tailscale을 쓰세요.

**데스크톱 앱에서도 작동하나요?** 네. 설정 → 플러그인 → **플러그인 추가** → `dsh-composer-plus`. dsh 0.2.0-rc.2(데스크톱과 웹)와 0.2.1-rc.2(웹)에서 테스트했습니다.

## 개발

스크린샷은 가짜 모델과 지어낸 데모 프로젝트(`acme-web`, `weather-cli`, `docs-site`)를 쓰는 일회용 dsh에서 다시 만듭니다. 그래서 실제 데이터가 들어 있지 않습니다. 기능 썸네일은 `assets/features/`에 둡니다(패키지에 포함되며 설정에 표시됨). README에서만 쓰는 그림은 `docs/images/`에 둡니다(npm 패키지에 포함되지 않음):

```sh
PLAYWRIGHT=/path/to/playwright node scripts/capture-screenshots.mjs /path/to/dsh/lib/bin.js
# sidebar project features (recent filter, Copy path, Collapse all): real-app test + their thumbnails
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-sidebar-projects.mjs /path/to/dsh/lib/bin.js
# recent filter + a finished chat older than 2 hours (fake model): the project stays until you open the chat
PLAYWRIGHT=/path/to/playwright node test/browser-recent-finished.mjs /path/to/dsh/lib/bin.js
# Order by status (fake model + Schedule): real-app test + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-status-order.mjs /path/to/dsh/lib/bin.js
# every Settings feature row shows a loading screenshot
PLAYWRIGHT=/path/to/playwright node test/browser-settings-shots.mjs /path/to/dsh/lib/bin.js
# Keep composer focus (fake model + demo skill): typing goes on after a / command + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-keep-focus.mjs /path/to/dsh/lib/bin.js
# Mobile connect: switch on, QR popover, a fake iPhone pairs and calls dsh through the gateway, switch off + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-mobile-connect.mjs /path/to/dsh/lib/bin.js
# Resume after restart (fake slow model, real quit and start): a running chat and a goal continue, a stopped chat does not
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-resume-restart.mjs /path/to/dsh/lib/bin.js
# Feature ideas (fake model, made-up project): suggest, drag left, Undo, ✓ starts a new chat in plan mode, ▶ Build now one without, Plan all one for the Later list, a focus topic chip, Copy as checklist + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-feature-ideas.mjs /path/to/dsh/lib/bin.js
# Export chat as Markdown (fake model, made-up project): right-click → Export as Markdown…, copy and save keep the code blocks, switch off + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-export-markdown.mjs /path/to/dsh/lib/bin.js
# Content search (fake model, made-up chats): a message-only word finds its chat with the snippet, switch off + restart = titles only + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-content-search.mjs /path/to/dsh/lib/bin.js
# Turn rollback + Delete chat (fake model, made-up git project): bash edit → ↶ Chat and files → files back, .git unchanged; Delete… → Trash + its thumbnails
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-turn-rollback.mjs /path/to/dsh/lib/bin.js
```

```sh
npm run build:locales # after editing locales/<id>.json
npm test
```

**새 기능 규칙:** 설정 → Composer Plus의 모든 기능 행에는 스크린샷이 표시됩니다. 기능 ID를 `client.js`의 `SHOT_OF`와 `index.js`의 `SHOTS`에 추가하세요. 그리고 `assets/features/<id>.webp`를 함께 배포하세요(일회용 데모 dsh에서 영어 UI로 찍은 약 60 kB 이하 이미지). 같은 이미지로 README 표에 기능을 추가하세요. `README.md`와 번역된 각 `README.<id>.md` 모두에 추가해야 합니다. 기능에 스크린샷이 없으면 `test/shots.test.mjs`가 실패합니다. `test/browser-settings-shots.mjs`는 실제 설정 페이지를 확인합니다. 모든 변경에 대한 전체 체크리스트는 [AGENTS.md](AGENTS.md)에 있습니다.

테스트는 실제 `client.js`를 가짜 React/DOM에서, 실제 `index.js`(Host 쪽)를 임시 git 저장소에서 실행합니다. Tether 게이트웨이 테스트(`test/tether-gateway.test.mjs`)는 모의 dsh 호스트와 실제 TLS 게이트웨이를 사용합니다. iPhone 앱은 `tether/ios`에 있습니다([tether/README.md](tether/README.md)와 [tether/AGENTS.md](tether/AGENTS.md) 참고). `node test/browser-history.mjs '<dsh web URL with ?token=…>'`는 실제 브라우저에서 입력 기록을 확인합니다. 이 확인은 자체 `DSH_HOME`을 쓰는 일회용 `dsh web`을 대상으로 실행됩니다.

언어 팩은 `locales/<id>.json`에 있는 데이터 전용 JSON입니다. `npm run build:locales`가 이 파일들을 단일 클라이언트 엔트리에 포함합니다(번역 서비스나 런타임 다운로드 없음). `npm test`는 모든 팩에서 전체 키 포함 여부, 자리 표시자와 줄바꿈 일치, 시스템 언어/직접 선택 동작을 확인합니다. 로컬에 설치한 Playwright로 격리된 실제 앱을 확인하려면:

```sh
PLAYWRIGHT=/path/to/playwright node test/browser-language.mjs /path/to/dsh/lib/bin.js
```

## License

MIT

# 유설Seol 꼬순내 추적기

유설Seol의 치지직 방송 시작과 커뮤니티·디스코드 새 글을 알려 주는 데스크톱 Chrome용 비공식 팬 확장 프로그램입니다. 방송을 앞으로 열거나, 백그라운드에서 열거나, 알림만 받을 수 있습니다. 최근 활동의 소식 바구니와 주간 발자국에서 지난 소식·다시보기·클립을 찾을 수 있습니다. 개발자 웃끼가 운영합니다.

## 설치

일반 사용자는 [Chrome 웹스토어](https://chromewebstore.google.com/detail/mojidkfjenpknjimjfobjnpgafceakpc)에서 설치할 수 있습니다. 웹스토어의 승인·게시와 GitHub 릴리스는 별도로 진행됩니다.

1. 직접 설치하려면 [GitHub Releases](https://github.com/jqu8ry/kkosunnae-tracker/releases)에서 원하는 버전의 `kkosunnae-tracker-버전.zip`을 받아 압축을 풉니다.
2. 데스크톱 Chrome 120 이상에서 `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 눌러 `manifest.json`이 들어 있는 폴더를 선택합니다. 설치 후에도 폴더를 보관하세요.
4. 툴바에서 추적기를 열고 알림을 허용합니다. 직접 설치한 버전은 다음 릴리스도 직접 업데이트해야 합니다.

## 소스와 기록

- 개발·검수·패키징 시 수정할 기준 폴더는 이 저장소의 `extension/`입니다. [개발 작업 원칙](AGENTS.md)에 다음 버전의 작업 순서를 정리했습니다.

- [확장 프로그램 소스](extension/)에는 제출 ZIP에 들어간 파일이 그대로 있습니다. 저장소에서 바로 실행하려면 이 폴더를 Chrome에 로드하세요. 별도 빌드 과정은 없습니다.
- [버전별 변경 이력](CHANGELOG.md)에서 개발 과정의 수정과 웹스토어 제출 시점을 확인할 수 있습니다.
- [1.9.75 배포 기록](docs/releases/1.9.75.md)에 주요 변경, 버전별 검수 범위, 제출 파일의 SHA-256을 정리했습니다.
- [설정·권한·사용 안내](extension/README.md) · [개인정보처리방침](https://jqu8ry.github.io/kkosunnae-tracker/privacy-policy.html) · [프로젝트 홈페이지](https://jqu8ry.github.io/kkosunnae-tracker/)

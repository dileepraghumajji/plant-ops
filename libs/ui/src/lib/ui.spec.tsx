import { render } from '@testing-library/react';

import PlantopsUi from './ui';

describe('PlantopsUi', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<PlantopsUi />);
    expect(baseElement).toBeTruthy();
  });
});
